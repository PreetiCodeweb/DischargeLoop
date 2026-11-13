-- The imported MedSync demo seed creates accounts with a fixed, publicly known password (demo123).
-- Never leave those usable: accounts are provisioned only via ADMIN_PASSWORD / DEMO_USER_PASSWORD or by an admin.
-- Kept (not deleted) because other synthetic Command Center rows may reference them.
UPDATE medsync.app_users
   SET is_active = false
 WHERE email IN ('admin@northstar.example', 'ops@northstar.example', 'admin.east@northstar.example');
