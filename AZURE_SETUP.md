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

Two ways to do the same thing. **Option A** needs no command line at all.

### Option A — from the Azure portal, no command line · من الـ Portal من غير أوامر

1. In the portal search box type **Deploy a custom template** and open it.
2. Click **Build your own template in the editor**, delete the sample text, paste
   the whole contents of [`infra/main.json`](./infra/main.json) from this
   repository, and click **Save**.
3. Fill in the form:
   - **Resource group** → *Create new* → `rg-qc-system`
   - **Region** → the one closest to the factory (`West Europe`, `UAE North` or `Qatar Central`)
   - **App Name** → `qc-system`
   - **Db Admin Password** → the PostgreSQL password you generated
   - **Jwt Secret** → the JWT secret you generated
   - **App Service Sku** → `F1` for a free trial, `B1` for production
   - **Allow Self Registration** → `true` (you close it after the first account)
   - **Factory Time Zone** → `Africa/Cairo`
4. **Review + create** → **Create**. It takes 5–10 minutes. When it finishes, open
   the deployment's **Outputs** tab: `webAppName` and `webAppUrl` are there.

من الـ Portal ابحث عن **Deploy a custom template**، اختار **Build your own template
in the editor**، الصق محتوى ملف `infra/main.json` كله واضغط Save. املأ الفورم زي
اللي فوق واضغط Create. بعد ما يخلص هتلاقي اسم الـ Web App والرابط في تاب
**Outputs**.

`infra/main.json` is generated from `infra/main.bicep` (`bicep build infra/main.bicep`);
edit the Bicep file and regenerate rather than editing the JSON.

### Option B — with the Azure CLI · بأداة az

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
`qatarcentral`).

**Trying it for free?** Add `appServiceSku=F1` to the parameters. The free tier
sleeps after 20 idle minutes (the first visitor then waits a few seconds) and
has a 60-minute CPU quota per day, which is enough to evaluate with a few
users. When the factory goes live, move to `B1` from the portal (App Service
plan → **Scale up**) with no redeploy. The database and photo storage sit
inside the free-account limits for the first 12 months either way.

للتجربة المجانية ضيف `appServiceSku=F1` للأمر. الخطة المجانية بتنام بعد 20 دقيقة
من غير استخدام وليها سقف 60 دقيقة معالجة في اليوم. لما تدخل الإنتاج حوّل لـ B1
من الـ Portal من غير ما تعيد النشر.

The deployment takes 5–10 minutes. At the end it prints:

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

The AI assistant's Anthropic API key is **optional** here and not part of the
template: an administrator sets it inside the app, under **Administration → AI
assistant**, where it is checked with Anthropic and stored encrypted (with a
key derived from `JWT_SECRET`); it is never shown again, only its last four
characters. If you prefer to keep it in Azure, add an Application setting
`ANTHROPIC_API_KEY`; set there, it wins over the key set in the app. Without
any key the assistant is simply off — the app runs as usual.

مفتاح Anthropic بتاع المساعد الذكي (AI assistant) مش لازم يتحط هنا: الـ admin
بيحطه من جوه البرنامج من Administration → AI assistant، وبيتخزن متشفر. لو
حطيت `ANTHROPIC_API_KEY` في الـ Application settings هو اللي بيتاخد بيه.

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
   configuration (or use **Bulk import** with CSV or Excel `.xlsx` files), grade
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
| Scale up                    | App Service plan → **Scale up** (e.g. F1 → B1); PostgreSQL server → **Compute + storage**. No redeploy needed. |
| Connect with a SQL client   | PostgreSQL server → **Networking** → add your client IP; connect with `sslmode=require`          |
| Rotate the JWT secret       | Set a new `JWT_SECRET`; everyone signs in again (refresh cookies stay valid). An AI assistant key set in the app can no longer be read: set it again under **Administration → AI assistant** |
| AI assistant key and cap    | **Administration → AI assistant**: the API key (checked with Anthropic before it is kept), on/off, and the monthly spending cap (default $50, UTC calendar month) |

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
- The AI assistant is for administrators only and can never change data: it
  reads through curated views in schema `ai` as its own database role
  (`<database>_ai_reader`), which may read nothing else, in read-only
  transactions that are always rolled back. Chat, notices, passwords, tokens
  and photos are outside those views. Its API key is stored encrypted, never
  returned by any endpoint and never written to the log or the audit trail.

## 7. Costs · التكلفة

With the default sizes (B1 App Service, B1ms PostgreSQL, LRS storage) the
monthly cost is in the range of tens of US dollars. Both compute resources can
be scaled up or down at any time from the portal without redeploying the
application.

The AI assistant, when it has a key, is billed by Anthropic per use. It stops
by itself at the monthly cap an administrator sets under **Administration → AI
assistant** (default $50 per UTC calendar month, the month Anthropic bills by),
and that page shows what was spent, by day and by person.

بالأحجام الافتراضية التكلفة الشهرية في حدود عشرات الدولارات، وتقدر تكبّر أو
تصغّر الحجم في أي وقت من الـ Portal من غير ما تعيد النشر.

## 8. Running it elsewhere · التشغيل في مكان تاني

Nothing is Azure-specific in the code. The API needs any PostgreSQL 14+ and, for
photos, either Azure Blob Storage (`IMAGE_STORAGE_DRIVER=azure-blob`) or a
local disk (`IMAGE_STORAGE_DRIVER=local`, development only). Build with
`npm run build`, package with `node scripts/package.mjs`, and run
`node dist/index.js` inside the `deploy/` folder with the variables from
`.env.example` set.
