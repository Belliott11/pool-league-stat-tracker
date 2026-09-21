import csv, json, statistics as st
from collections import defaultdict
import os
d=json.load(open(os.environ.get('SHOTARC_EXPORT', r'C:\Users\breso\Downloads\pool-league-data (9).json'))); d=d.get('state',d)
tags={}
for g in d['games']:
    for e in g['scoringEvents']:
        if e.get('videoTime') is not None:
            tags[(g['id'], round(e['videoTime'],3))]=e
rows=list(csv.DictReader(open('shot_arcs_features.csv')))
joined=[]
for r in rows:
    gid,a,b=r['key'].rsplit('_',2)
    vt=round(float(f"{a}.{b}"),3)
    e=tags.get((gid,vt))
    if e is None:
        near=[v for (g2,t),v in tags.items() if g2==gid and abs(t-vt)<0.01]
        e=near[0] if near else None
    r['type']=('dunk' if (e or {}).get('dunk') else (e or {}).get('shotType')); r['matched']=e is not None
    joined.append(r)
print('arc rows',len(rows),'matched to a logged shot',sum(r['matched'] for r in joined))
by=defaultdict(list)
for r in joined:
    by[r['type'] or 'untagged'].append(r)
print({k:len(v) for k,v in by.items()})
feats=['flight_s_z','arch_ratio_z','apex_frac_z','speed_px_s_z','span_px_z']
def mean(x): return sum(x)/len(x) if x else float('nan')
print('type', 'n', 'dist', 'made%', *feats)
for k,v in sorted(by.items(), key=lambda kv:-len(kv[1])):
    print(k,len(v), round(mean([float(r['dist']) for r in v]),1), round(100*mean([int(r['made']) for r in v])), *[round(mean([float(r[f]) for r in v]),2) for f in feats])
# who are the tagged ones
for k,v in by.items():
    if k!='untagged': print(k,[ (r['shooter'],r['points'],r['made']) for r in v])

print('\n--- distance-adjusted (residual after regressing each z-feature on distance, all arcs) ---')
import numpy as np
from scipy.stats import mannwhitneyu
D=np.array([float(r['dist']) for r in joined])
res={}
for f in feats:
    y=np.array([float(r[f]) for r in joined]); A=np.vstack([D,np.ones_like(D)]).T
    coef=np.linalg.lstsq(A,y,rcond=None)[0]; res[f]=y-A@coef
    print(f,'slope per 10 units of distance',round(coef[0]*10,3),'corr',round(np.corrcoef(D,y)[0,1],2))
typ=np.array([r['type'] or 'untagged' for r in joined])
def cmp(a,b):
    ia,ib=typ==a,typ==b
    print(f'\n{a} (n={ia.sum()}) vs {b} (n={ib.sum()})')
    for f in feats:
        x,y=res[f][ia],res[f][ib]
        u,p=mannwhitneyu(x,y,alternative='two-sided')
        rb=2*u/(len(x)*len(y))-1
        print(f'  {f}: mean resid {x.mean():+.2f} vs {y.mean():+.2f}  rank-biserial {rb:+.2f}  p={p:.3f}')
cmp('deepHeave','catchAndShoot'); cmp('drive','catchAndShoot')
# distance overlap
for t in ['catchAndShoot','deepHeave','drive','move']:
    x=D[typ==t]; print(t,'dist range',round(x.min()),round(x.max()),'median',round(np.median(x)))
print('\nfar shots only (dist>=75): types',{t:int(((typ==t)&(D>=75)).sum()) for t in set(typ)})
