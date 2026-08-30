import json, subprocess
res = subprocess.run(["npm.cmd", "audit", "--json"], capture_output=True, text=True)
try:
    data = json.loads(res.stdout)
    for k,v in data.get("vulnerabilities", {}).items():
        if v.get("severity") in ["moderate", "high", "critical"]:
            via_names = [via.get("name", via) if isinstance(via, dict) else via for via in v.get("via", [])]
            print(f"{v['severity'].upper()}: {k} (via {via_names})")
            print(f"  Fix available: {v.get('fixAvailable')}")
except Exception as e:
    print(e)
