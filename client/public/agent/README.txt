QC Inspection Recorder — Access order sync
==========================================

This folder sends the order sheet from the factory's Access database to the
QC application every 15 minutes, or within a minute of "Sync now".
The Access file is opened READ-ONLY; it is never changed.

What you need
-------------
- A Windows PC that stays on, that can open the Access file (local disk or
  network share).
- The Microsoft Access Database Engine. It comes with Office/Access; without
  Office, install "Microsoft Access Database Engine 2016 Redistributable" in
  the same 32/64-bit as Office.
- From the application (Administration > Data import > Access sync):
  a new integration key, and its config.json.

Steps
-----
1. Make a folder on the PC, e.g. C:\QcSync, and put in it:
     Sync-AccessOrders.ps1, Install-Task.ps1, config.json
2. Open config.json in Notepad and set:
     "databasePath": the full path of the .accdb/.mdb file,
                     e.g. "\\\\SERVER\\Planning\\Orders.accdb" or "D:\\ERP\\Orders.accdb"
     "table":        the orders table, e.g. "Orders"
                     (or remove "table" and set "query" to a SELECT)
     "databasePassword": only if the Access file has a password.
   Keep apiUrl and apiKey as they came.
3. Open PowerShell "Run as administrator", then:
     cd C:\QcSync
     .\Install-Task.ps1
   It reads the table once (dry run), then registers the task. Type the
   Windows password of the account when asked. If the Access file is on this
   PC's own disk you may use:  .\Install-Task.ps1 -AsSystem
4. In the application, press "Sync now" and watch the run appear.

Checks
------
- Test without sending:   .\Sync-AccessOrders.ps1 -DryRun
- Sync now from the PC:   .\Sync-AccessOrders.ps1 -Force
- The log:                sync.log in the same folder
- Stop the sync:          schtasks /Delete /TN "QC Access order sync" /F

Safety
------
- config.json holds the key: keep the folder readable only by the account
  that runs the task. A lost key is revoked in the application in one click.
- A line that left the Access table is retired in the application only when
  the whole table arrived and read cleanly, and never more than half the
  lines at once. Its sessions and history are always kept.

----------------------------------------------------------------------------

بالعربي
-------
الفولدر ده بيبعت جدول الأوردرات من ملف الـ Access للأبلكيشن كل ربع ساعة، أو في خلال
دقيقة من ما حد يدوس "Sync now". الملف بيتفتح قراءة بس، وعمره ما يتعدّل.

1) اعمل فولدر على جهاز شغال على طول، مثلاً C:\QcSync، وحط فيه الـ 3 ملفات:
   Sync-AccessOrders.ps1 و Install-Task.ps1 و config.json (بتنزّله من الأبلكيشن).
2) افتح config.json بالـ Notepad وغيّر:
   databasePath = مسار ملف الـ Access كامل
   table        = اسم جدول الأوردرات
   databasePassword = بس لو الملف عليه باسورد
3) افتح PowerShell كـ Administrator واكتب:
   cd C:\QcSync
   .\Install-Task.ps1
   هيقرا الجدول مرة للتجربة، وبعدين يسجّل المهمة، وهيطلب باسورد الويندوز بتاع الحساب.
4) من الأبلكيشن دوس "Sync now" وهتلاقي الـ run ظهر في خلال دقيقة.
