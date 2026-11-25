-- كل فرع له مستودعه: حساب مسؤول المستودع يتربط بفرع ويشوف فسوحات فرعه فقط.
-- branch فاضي = كل الفروع (حسابات الإدارة، والحسابات القديمة قبل هذا التحديث).
ALTER TABLE users ADD COLUMN branch TEXT;

-- الموظفون والموصلون لكل فرع (فاضي = يظهرون في كل الفروع، مثل الأسماء القديمة)
ALTER TABLE workers ADD COLUMN branch TEXT;
ALTER TABLE couriers ADD COLUMN branch TEXT;

-- نفس الاسم مسموح في فرعين مختلفين (محمد في جدة ومحمد في الرياض)
DROP INDEX idx_workers_name;
DROP INDEX idx_couriers_name;
CREATE UNIQUE INDEX idx_workers_branch_name ON workers (IFNULL(branch, ''), name COLLATE NOCASE);
CREATE UNIQUE INDEX idx_couriers_branch_name ON couriers (IFNULL(branch, ''), name COLLATE NOCASE);

CREATE INDEX idx_documents_branch ON documents (branch, status);
