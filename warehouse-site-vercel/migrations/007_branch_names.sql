-- أسماء الفروع تنحفظ بدون كلمة "فرع" (الشاشات تكتب "فرع X")، عشان ما يطلع "فرع فرع القصيم"
-- وما يصير نفس الفرع باسمين. (مفاتيح ملفات الطابعة في الإعدادات تتصلح في الكود.)
UPDATE OR IGNORE relay_devices SET branch = trim(substr(branch, 6)) WHERE branch LIKE 'الفرع %';
UPDATE OR IGNORE relay_devices SET branch = trim(substr(branch, 4)) WHERE branch LIKE 'فرع %';
UPDATE OR IGNORE documents SET branch = trim(substr(branch, 6)) WHERE branch LIKE 'الفرع %';
UPDATE OR IGNORE documents SET branch = trim(substr(branch, 4)) WHERE branch LIKE 'فرع %';
UPDATE OR IGNORE users SET branch = trim(substr(branch, 6)) WHERE branch LIKE 'الفرع %';
UPDATE OR IGNORE users SET branch = trim(substr(branch, 4)) WHERE branch LIKE 'فرع %';
UPDATE OR IGNORE couriers SET branch = trim(substr(branch, 6)) WHERE branch LIKE 'الفرع %';
UPDATE OR IGNORE couriers SET branch = trim(substr(branch, 4)) WHERE branch LIKE 'فرع %';
UPDATE OR IGNORE workers SET branch = trim(substr(branch, 6)) WHERE branch LIKE 'الفرع %';
UPDATE OR IGNORE workers SET branch = trim(substr(branch, 4)) WHERE branch LIKE 'فرع %';
