import sys; sys.path.insert(0, '.')
from services.lead_parser import parse_leads_file
from collections import Counter
import json

with open(r'd:\MIS\Local_sheets\Lead Management\IVR-Whatsapp Ledas Month of April (1).xlsx', 'rb') as f:
    data = f.read()

records, errors = parse_leads_file(data, 'april.xlsx')
print(f'Records parsed: {len(records)}')
print(f'Messages: {errors}')
print('Sample record:')
print(json.dumps(records[0], indent=2, default=str))

print('\nASM distribution (top 10):')
asms = Counter(r['assigned_asm'] for r in records if r['assigned_asm'])
for name, count in asms.most_common(10):
    print(f'  {name}: {count}')

print('\nReason categories:')
cats = Counter(r['reason_category'] for r in records)
for cat, count in cats.most_common():
    print(f'  {cat}: {count}')

print('\nTop states:')
states = Counter(r['state'] for r in records if r['state'])
for s, c in states.most_common(5):
    print(f'  {s}: {c}')
