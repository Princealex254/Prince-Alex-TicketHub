-- Persist the organizer's handwritten signature image with each signed record.
ALTER TABLE organizer_agreements ADD COLUMN signature_image TEXT;