-- فسوحات من قبل الفروع (branch فاضي) تنحسب على الفرع الرئيسي، عشان يشوفها حساب مستودعه
UPDATE documents
SET branch = COALESCE(NULLIF(trim((SELECT json_extract(value_json, '$') FROM settings WHERE key = 'main_branch_name')), ''), 'جدة')
WHERE branch IS NULL OR trim(branch) = '';
