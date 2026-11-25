-- المرحلة 3: رسائل العميل في واتساب — نوع الحدث لكل رسالة (حتى ما تتكرر نفس الرسالة للعميل بعد تصحيح الحالة)
ALTER TABLE wa_notifications ADD COLUMN event_type TEXT;
CREATE INDEX idx_wa_notifications_doc ON wa_notifications (document_id, target, event_type, state);
