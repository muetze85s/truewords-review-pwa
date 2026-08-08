-- Pilot v1: workload-balanced chronological split.
-- 250 assigned messages: Philipp situations 1-11 = 134 messages;
-- Lena situations 12-29 = 116 messages.
UPDATE review_datasets
SET owners_json = '{"1":"Philipp","2":"Philipp","3":"Philipp","4":"Philipp","5":"Philipp","6":"Philipp","7":"Philipp","8":"Philipp","9":"Philipp","10":"Philipp","11":"Philipp","12":"Lena","13":"Lena","14":"Lena","15":"Lena","16":"Lena","17":"Lena","18":"Lena","19":"Lena","20":"Lena","21":"Lena","22":"Lena","23":"Lena","24":"Lena","25":"Lena","26":"Lena","27":"Lena","28":"Lena","29":"Lena"}',
    revision = revision + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'philena-2026'
  AND json_array_length(json_extract(annotations_json, '$.situations')) = 29;
