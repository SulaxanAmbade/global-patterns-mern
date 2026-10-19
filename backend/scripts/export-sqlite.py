"""Read the existing Streamlit database without modifying it. Standard Python only."""
import argparse, sqlite3, json, sys
p=argparse.ArgumentParser();p.add_argument('database');p.add_argument('output');a=p.parse_args()
conn=sqlite3.connect('file:'+a.database+'?mode=ro',uri=True);conn.row_factory=sqlite3.Row
has_pairs=conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='internal_pattern_keyword_training'").fetchone()
cols=set()
if has_pairs:
 conn.execute('CREATE TEMP TABLE keyword_snapshot AS SELECT * FROM internal_pattern_keyword_training')
 cols={r[1] for r in conn.execute('PRAGMA temp.table_info(keyword_snapshot)')}
 conn.execute('CREATE INDEX temp.source_index ON keyword_snapshot(source_pattern,language)')
with open(a.output,'w',encoding='utf-8') as f:
 for source in conn.execute('SELECT * FROM url_patterns ORDER BY id'):
  row=dict(source);row.pop('id',None)
  if has_pairs:
   sql='SELECT keyword FROM keyword_snapshot WHERE source_pattern=? AND language=?';params=[row.get('url_pattern',''),row.get('language_code','')]
   if 'source_admin_name' in cols:sql+=' AND (source_admin_name=? OR source_admin_name IS NULL)';params.append(row.get('admin_name',''))
   row['pattern_keywords']=[r[0] for r in conn.execute(sql,params)]
  f.write(json.dumps(row,ensure_ascii=False)+'\n')
conn.close();print('Export complete:',a.output)
