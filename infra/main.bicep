// ============================================================================
// QC System — Azure infrastructure (one resource group)
//
//   • Azure Database for PostgreSQL Flexible Server  (the database)
//   • Storage account + private blob container       (inspection photos)
//   • App Service plan + Linux Web App (Node 20)     (API + client, one origin)
//
// Deploy:
//   az group create -n rg-qc-system -l <region>
//   az deployment group create -g rg-qc-system -f infra/main.bicep \
//        -p appName=qc-system dbAdminPassword='<strong password>' jwtSecret='<48 random bytes>'
//
// Everything the app needs at runtime is written into the Web App's settings
// by this template, so after the deployment the only remaining step is to
// publish the code (see .github/workflows/azure-deploy.yml).
// ============================================================================

@description('Short name used as a prefix for every resource (letters and digits).')
@minLength(3)
@maxLength(20)
param appName string = 'qc-system'

@description('Azure region for every resource.')
param location string = resourceGroup().location

@description('Administrator login for PostgreSQL.')
param dbAdminLogin string = 'qcadmin'

@description('Administrator password for PostgreSQL. 16+ characters, mixed classes.')
@secure()
@minLength(16)
param dbAdminPassword string

@description('Secret used to sign access tokens. 32+ characters; generate with `openssl rand -base64 48`.')
@secure()
@minLength(32)
param jwtSecret string

@description('''App Service plan SKU.
  F1  free tier for a first trial: the app sleeps after 20 idle minutes and has a
      60-minute CPU quota per day. Fine to evaluate with a few users.
  B1  the production starting point: always on, no daily quota.
Scale between them later from the portal without redeploying.''')
@allowed(['F1', 'B1', 'B2', 'B3', 'P0v3', 'P1v3'])
param appServiceSku string = 'B1'

@description('PostgreSQL compute. Burstable B1ms is enough to start; storage is set separately.')
param dbSkuName string = 'Standard_B1ms'

@description('PostgreSQL storage in GB.')
param dbStorageGb int = 32

@description('Whether people may create their own account from the login screen (first account is always allowed).')
param allowSelfRegistration bool = false

@description('IANA time zone the factory runs on; shifts are derived in it.')
param factoryTimeZone string = 'Africa/Cairo'

var suffix = uniqueString(resourceGroup().id)
var storageName = toLower(replace('${take(appName, 11)}${suffix}', '-', ''))
var dbServerName = toLower('${appName}-pg-${suffix}')
var webAppName = toLower('${appName}-${suffix}')
var dbName = 'qc'
var containerName = 'qc-images'

// ---- PostgreSQL ------------------------------------------------------------

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: dbServerName
  location: location
  sku: {
    name: dbSkuName
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: dbAdminLogin
    administratorLoginPassword: dbAdminPassword
    storage: {
      storageSizeGB: dbStorageGb
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 14
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

resource pgDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: pg
  name: dbName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// The App Service reaches the database over Azure's backbone; this rule admits
// Azure-internal addresses. Tighten to the Web App's outbound IPs if required.
resource pgAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01-preview' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// ---- Blob storage for photos ----------------------------------------------

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 30
    }
  }
}

resource imagesContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: containerName
  properties: {
    publicAccess: 'None'
  }
}

// ---- App Service -----------------------------------------------------------

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${appName}-plan'
  location: location
  kind: 'linux'
  sku: {
    name: appServiceSku
    tier: appServiceSku == 'F1' ? 'Free' : (startsWith(appServiceSku, 'B') ? 'Basic' : 'PremiumV3')
  }
  properties: {
    reserved: true
  }
}

var storageConnection = 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
var databaseUrl = 'postgresql://${dbAdminLogin}:${uriComponent(dbAdminPassword)}@${pg.properties.fullyQualifiedDomainName}:5432/${dbName}?sslmode=require'

resource web 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  kind: 'app,linux'
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      alwaysOn: appServiceSku != 'F1'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      appCommandLine: 'node dist/index.js'
      // Health-check pings keep an instance monitored on paid tiers; on the
      // free tier they would only burn the daily CPU quota.
      healthCheckPath: appServiceSku == 'F1' ? null : '/api/health'
      appSettings: [
        { name: 'NODE_ENV', value: 'production' }
        { name: 'DATABASE_URL', value: databaseUrl }
        { name: 'JWT_SECRET', value: jwtSecret }
        { name: 'IMAGE_STORAGE_DRIVER', value: 'azure-blob' }
        { name: 'AZURE_STORAGE_CONNECTION_STRING', value: storageConnection }
        { name: 'AZURE_STORAGE_CONTAINER', value: containerName }
        { name: 'AUTH_ALLOW_SELF_REGISTRATION', value: string(allowSelfRegistration) }
        { name: 'RUN_MIGRATIONS_ON_START', value: 'true' }
        { name: 'SEED_DEMO_DATA', value: 'false' }
        { name: 'TRUST_PROXY', value: 'true' }
        { name: 'FACTORY_TIMEZONE', value: factoryTimeZone }
        { name: 'STATIC_DIR', value: 'public' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
      ]
    }
  }
  dependsOn: [
    pgDatabase
    imagesContainer
  ]
}

output webAppName string = web.name
output webAppUrl string = 'https://${web.properties.defaultHostName}'
output postgresHost string = pg.properties.fullyQualifiedDomainName
output storageAccount string = storage.name
