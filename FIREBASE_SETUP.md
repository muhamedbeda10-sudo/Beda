# Firebase Setup · إعداد Firebase

The app runs in **local demo mode** with no configuration. To make data **shared
across devices/users** with **login** and **image storage**, connect Firebase.

التطبيق يشتغل في **وضع تجريبي محلي** من غير أي إعداد. عشان الداتا تبقى **مشتركة بين
كل الأجهزة والمستخدمين** مع **تسجيل دخول** و**تخزين صور**، اربط Firebase بالخطوات دي.

---

## 1. Create a Firebase project · أنشئ مشروع

1. Go to <https://console.firebase.google.com> → **Add project**.
2. Give it a name (e.g. `qc-system`) → continue → create.
   - روح على الكونسول واعمل **Add project** واختار اسم.

## 2. Enable the services · فعّل الخدمات

- **Authentication** → Get started → **Sign-in method** → enable **Email/Password**.
  - فعّل تسجيل الدخول بالإيميل والباسورد.
- **Firestore Database** → Create database → Start in **production mode** → pick a region.
  - أنشئ Firestore واختار Production mode.
- **Storage** → Get started → pick the same region.
  - فعّل Storage.

## 3. Register a Web app · سجّل تطبيق ويب

1. Project Overview → click the **`</>`** (Web) icon → register app.
2. Copy the `firebaseConfig` values it shows.
   - انسخ قيم `firebaseConfig`.

## 4. Add the config · ضيف الإعدادات

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

```env
VITE_FIREBASE_API_KEY=AIza...
VITE_FIREBASE_AUTH_DOMAIN=qc-system.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=qc-system
VITE_FIREBASE_STORAGE_BUCKET=qc-system.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=1234567890
VITE_FIREBASE_APP_ID=1:1234567890:web:abcdef
```

> Restart `npm run dev` after editing `.env`. Once these are set, the app shows a
> **login screen** and stores everything in Firebase instead of the browser.
> بعد ما تحطهم، التطبيق هيطلب تسجيل دخول ويخزن كل حاجة على Firebase.

## 5. Deploy the security rules · انشر قواعد الحماية

Install the CLI once, then deploy the included `firestore.rules` and `storage.rules`:

```bash
npm install -g firebase-tools
firebase login
firebase use --add            # pick your project
firebase deploy --only firestore:rules,storage
```

## 6. First run · أول تشغيل

- Open the app → **Create account** → sign in.
- On first sign-in, if the database is empty it is **auto-seeded** with the demo
  data so you can see the system populated. Real usage then writes live.
  - أول ما تسجل، لو الداتابيز فاضية هتتزرع أوتوماتيك بالبيانات التجريبية.

### Roles · الصلاحيات

New users get the **`inspector`** role (Inspections + History only). To grant more
access, open **Firestore → `users` → {uid}** and set `role` to `supervisor`
(adds Analytics + Settings) or `manager` (adds Audit Logs + role management).

المستخدم الجديد بياخد صلاحية **inspector**. لترقيته، غيّر حقل `role` في
`users/{uid}` إلى `supervisor` أو `manager`.

---

## Later: deploy to Vercel · النشر على Vercel لاحقًا

When you're ready to host it: import the GitHub repo in Vercel, set **Framework =
Vite**, and add the same `VITE_FIREBASE_*` variables under **Settings →
Environment Variables**. Also add your Vercel domain to **Firebase → Auth →
Settings → Authorized domains**.

لما تيجي تنشر: اربط الريبو في Vercel، اختَر Framework = Vite، وحط نفس متغيرات
`VITE_FIREBASE_*` في إعدادات Environment Variables، وأضف دومين Vercel في
Authorized domains بتاعت Firebase Auth.
