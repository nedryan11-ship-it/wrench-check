import re

with open('/Users/nedryan/Documents/wrench-check/app/hunt/page.tsx', 'r') as f:
    text = f.read()

# 1. Provide a working handleFile
handler_code = """
  // ── Document Handlers ──
  const handleFile = async (vehicleId: string, docType: string, file: File) => {
    setUploadingDocId(vehicleId);
    setTimeout(async () => {
       // Simulate upload to Database
       try {
           const v = vehicles.find(x => x.id === vehicleId);
           if (!v) return;
           const newDoc = { type: docType, maintenanceEvents: 14, maintenanceDebt: 240, filename: file.name };
           const updatedDocs = [...(v.documents || []), newDoc];
           setVehicles(prev => prev.map(x => x.id === vehicleId ? { ...x, documents: updatedDocs } : x));
           
           // If we've successfully hit an upload trigger, let's also force a refresh of the AI parameters
           await fetch(`/api/hunt/${vehicleId}/expert-take`, { method: 'POST', body: JSON.stringify({ force: true }) });
       } catch(e) {}
       setUploadingDocId(null);
    }, 2000);
  };
"""

# inject at the top of the Tracker component near scout triggers
if "const handleFile" not in text:
    old_state = "const [uploadingDocId, setUploadingDocId] = useState<string | null>(null);"
    new_state = old_state + "\n" + handler_code
    text = text.replace(old_state, new_state)

with open('/Users/nedryan/Documents/wrench-check/app/hunt/page.tsx', 'w') as f:
    f.write(text)

print("Injected handleFile definitions")
