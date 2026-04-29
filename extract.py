with open('/Users/nedryan/Documents/wrench-check/app/hunt/page.tsx', 'r') as f:
    text = f.read()

# 1. DELETE DOSSIER
dossier_start = text.find('{/* ── DOSSIER')
if dossier_start > -1:
    dossier_end = text.find('{/* ── EXPANDED SCORE BREAKDOWN ── */}')
    if dossier_end > -1:
        text = text[:dossier_start] + text[dossier_end:]

# 2. Extract Chat Continuation
chat_start = text.find('{/* ── CHAT CONTINUATION')
if chat_start > -1:
    chat_end = text.find('</div>', text.find('</button>', chat_start)) + 6
    chat_end2 = text.find('</div>', chat_end) + 6 # close the wrapper
    # We will just remove it, and rebuild a cleaner one inside Path To Gem
    pass

with open('patched_page.tsx', 'w') as f:
    f.write(text)
print("done")
