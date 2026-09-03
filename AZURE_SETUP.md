# Azure Setup · إعداد Azure

Everything the QC System needs on Azure, created once with one command, then
deployed automatically on every push to `main`.

كل اللي البرنامج محتاجه على Azure بيتعمل مرة واحدة بأمر واحد، وبعدها النشر
بيحصل أوتوماتيك مع كل push على `main`.

What gets created · اللي هيتعمل:

| Resource                                     | Purpose · الغرض                                        | Starting size |
| -------------------------------------------- | ------------------------------------------------------ | ------------- |
| Azure Database for PostgreSQL Flexible Server | The database · الداتا بيز                               | B1ms, 32 GB   |
| Storage account (private container)          | Inspection photos · صور الفحص                           | Standard LRS  |
| App Service plan + Web App (Linux, Node 20)  | The API and the web client · البرنامج نفسه              | B1            |

---

## 1. Prerequisites · المتطلبات

- An Azure subscription where you can create resource groups.
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) installed
  and signed in: `az login`.
- Two secrets you generate yourself and keep somewhere safe (a password
  manager):

```bash
# PostgreSQL admin password (16+ chars, letters + digits + symbols)
openssl rand -base64 24

# JWT secret (signs the app's access tokens)
openssl rand -base64 48
```

اشتراك Azure، وأداة `az` مسجّل دخول بيها، وكلمتين سر بتولّدهم بالأوامر دي وتحفظهم في مكان آمن.

## 2. Create the infrastructure · إنشاء البنية التحتية

```bash
az group create --name rg-qc-system --location westeurope

az deployment group create \
  --resource-group rg-qc-system \
  --template-file infra/main.bicep \
  --parameters appName=qc-system \
               dbAdminPassword='<the PostgreSQL password>' \
               jwtSecret='<the JWT secret>' \
               allowSelfRegistration=true \
               factoryTimeZone=Africa/Cairo
```

Pick the region closest to the factory (for Egypt: `westeurope`, `uaenorth` or
`qatarcentral`). The deployment takes 5–10 minutes. At the end it prints:

```
webAppName   qc-system-xxxxxxxx
webAppUrl    https://qc-system-xxxxxxxx.azurewebsites.net
postgresHost qc-system-pg-xxxxxxxx.postgres.database.azure.com
```

اختار أقرب Region للمصنع. الأمر بياخد من 5 لـ 10 دقايق وفي الآخر بيطبع اسم
الـ Web App والرابط بتاعه.

The template writes every runtime setting (`DATABASE_URL`, `JWT_SECRET`,
`AZURE_STORAGE_CONNECTION_STRING`, …) into the Web App's **Configuration →
Application settings**. You never put a secret in the repository.

## 3. Connect GitHub to the Web App · ربط GitHub بالـ Web App

1. Azure portal → the Web App → **Overview → Get publish profile**. A `.PublishSettings`
   file downloads; open it and copy the whole XML.
2. GitHub → the repository → **Settings → Secrets and variables → Actions → New repository secret**:
   - `AZURE_WEBAPP_NAME` = the `webAppName` printed above
   - `AZURE_WEBAPP_PUBLISH_PROFILE` = the XML
3. Push to `main` (or run the **Deploy to Azure App Service** workflow by hand).
   The workflow runs every test against PostgreSQL, builds the client and the
   API, packages them, and publishes. The API applies the database schema
   itself when it starts.

من الـ Portal حمّل الـ publish profile، وحطه مع اسم الـ Web App في
GitHub Secrets، وبعدها أي push على `main` بينشر لوحده. الجداول بتتعمل
أوتوماتيك أول ما البرنامج يشتغل.

## 4. First run · أول تشغيل

1. Open the `webAppUrl`. The first screen is **Create account** — the first
   account becomes the **admin**.
2. Go to **Admin → Users** and create the inspectors and supervisors.
3. Close self-registration so nobody else can create an account from the login
   screen:

```bash
az webapp config appsettings set -g rg-qc-system -n <webAppName> \
  --settings AUTH_ALLOW_SELF_REGISTRATION=false
```

4. Load master data from **Admin**: machines, work-centre defects, dimension
   configuration (or use **Bulk import** with the CSV templates), grade
   mappings, PT consumables, and the production orders and coils from the ERP.

أول حساب يتعمل بيبقى الـ admin. اعمل حسابات المفتشين من Admin → Users، وبعدها
اقفل التسجيل الذاتي بالأمر اللي فوق، وبعدين حمّل الـ master data من Admin.

## 5. Day-to-day operations · التشغيل اليومي

| Task                        | How                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| Logs                        | Web App → **Log stream**, or `az webapp log tail -g rg-qc-system -n <webAppName>`                |
| Health                      | `https://<webAppUrl>/api/health` answers `{"ok":true,"database":"up"}`; App Service pings it     |
| Change a setting            | Web App → **Configuration → Application settings** (the app restarts)                            |
| Database backups            | Automatic, 14-day retention (point-in-time restore from the PostgreSQL server's **Backups**)     |
| Photo backups               | Soft delete is on for 30 days; add lifecycle / geo-redundancy in the storage account if needed   |
| Scale up                    | App Service plan → **Scale up**; PostgreSQL server → **Compute + storage**. No redeploy needed.  |
| Connect with a SQL client   | PostgreSQL server → **Networking** → add your client IP; connect with `sslmode=require`          |
| Rotate the JWT secret       | Set a new `JWT_SECRET`; everyone signs in again (refresh cookies stay valid)                      |

## 6. Security notes · ملاحظات أمنية

- The blob container is **private**; photos are only served through the API to
  signed-in users, and every stored file keeps its SHA-256.
- PostgreSQL enforces TLS; the connection string carries `sslmode=require`.
- The firewall rule created by the template admits Azure-internal addresses so
  the Web App can reach the database. To narrow it, replace it with the Web
  App's outbound IPs (`az webapp show -n <webAppName> -g rg-qc-system --query outboundIpAddresses`)
  or move both into a virtual network.
- Passwords are hashed with scrypt; sign-in is rate-limited per email and IP.
- Deactivating a user (Admin → Users) signs them out everywhere immediately.

## 7. Costs · التكلفة

With the default sizes (B1 App Service, B1ms PostgreSQL, LRS storage) the
monthly cost is in the range of tens of US dollars. Both compute resources can
be scaled up or down at any time from the portal without redeploying the
application.

بالأحجام الافتراضية التكلفة الشهرية في حدود عشرات الدولارات، وتقدر تكبّر أو
تصغّر الحجم في أي وقت من الـ Portal من غير ما تعيد النشر.

## 8. Running it elsewhere · التشغيل في مكان تاني

Nothing is Azure-specific in the code. The API needs any PostgreSQL 14+ and, for
photos, either Azure Blob Storage (`IMAGE_STORAGE_DRIVER=azure-blob`) or a
local disk (`IMAGE_STORAGE_DRIVER=local`, development only). Build with
`npm run build`, package with `node scripts/package.mjs`, and run
`node dist/index.js` inside the `deploy/` folder with the variables from
`.env.example` set.
