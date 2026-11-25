-- أصناف الفسح وكمياتها (من جدول الأصناف في الفسح) — لتقرير الموظفين: كم صنف وكم قطعة جهّز
ALTER TABLE documents ADD COLUMN items_count INTEGER;
ALTER TABLE documents ADD COLUMN items_qty REAL;
