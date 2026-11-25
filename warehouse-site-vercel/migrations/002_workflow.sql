-- المرحلة 2: ربط حدث بحدث سابق (إقفال النقص يشير إلى النقص الذي أقفله)
ALTER TABLE document_events ADD COLUMN ref_event_id INTEGER REFERENCES document_events(id);
CREATE INDEX idx_document_events_ref ON document_events (ref_event_id);

CREATE INDEX idx_documents_handed ON documents (handed_over_at);
