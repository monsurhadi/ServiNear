#!/usr/bin/env python3
"""Fix null-safety issues in app.js and finder.js"""
import sys

# ── app.js ────────────────────────────────────────────────────────────────────
app_path = r"c:\Users\Asad\Downloads\ServiNear-Marketplace-vercel-docker\ServiNear-Marketplace\public\app.js"
with open(app_path, "r", encoding="utf-8") as f:
    src = f.read()

original_len = len(src)

# Fix 1: register handler – guard state.user after reload (reload may null it on cross-origin)
src = src.replace(
    'const result = await post("/api/auth/register", values);\n'
    '      state.user = result.user;\n'
    '      $("#auth-dialog")?.close();\n'
    '      await reload();\n'
    '      toast(`Welcome, ${state.user.name}! Account created.`);',
    'const result = await post("/api/auth/register", values);\n'
    '      const _regUser = result.user;\n'
    '      state.user = _regUser;\n'
    '      $("#auth-dialog")?.close();\n'
    '      await reload();\n'
    '      const _regName = state.user?.name || _regUser?.name || "there";\n'
    '      toast(`Welcome, ${_regName}! Account created.`);'
)

# Fix 2: login handler – guard state.user after reload
src = src.replace(
    'const result = await post("/api/auth/login", values);\n'
    '      state.user = result.user;\n'
    '      $("#auth-dialog")?.close();\n'
    '      await reload();\n'
    '      toast(`Welcome back, ${state.user.name.split(" ")[0]}!`);',
    'const result = await post("/api/auth/login", values);\n'
    '      const _loginUser = result.user;\n'
    '      state.user = _loginUser;\n'
    '      $("#auth-dialog")?.close();\n'
    '      await reload();\n'
    '      const _loginName = (state.user?.name || _loginUser?.name || "there").split(" ")[0];\n'
    '      toast(`Welcome back, ${_loginName}!`);'
)

# Fix 3: renderProfile – guard state.user.name on line 911
src = src.replace(
    '  if (nameEl) nameEl.textContent = state.user.name;',
    '  if (nameEl) nameEl.textContent = state.user?.name || "";'
)

# Fix 4: profile avatarCircle – already has (state.user.name||"U") but guard state.user itself
# Lines 895-907: already guarded by the if(!state.user) check at L880 → safe.

# Fix 5: support form pre-fill on L2918 – already inside if(state.user) → safe.
# Fix 6: profile-user-name on L2330 – already inside if(state.user) check → safe.

# Verify all replacements happened
assert 'state.user.name.split(" ")[0]}!`);' not in src, "Login toast fix failed!"
assert 'state.user.name}! Account created' not in src, "Register toast fix failed!"
assert 'if (nameEl) nameEl.textContent = state.user.name;' not in src, "renderProfile fix failed!"

with open(app_path, "w", encoding="utf-8") as f:
    f.write(src)

print("[app.js] Done - %d -> %d bytes" % (original_len, len(src)))

# ── finder.js ─────────────────────────────────────────────────────────────────
finder_path = r"c:\Users\Asad\Downloads\ServiNear-Marketplace-vercel-docker\ServiNear-Marketplace\public\finder.js"
with open(finder_path, "r", encoding="utf-8") as f:
    fsrc = f.read()

foriginal_len = len(fsrc)

# Fix: onCredential – guard state.user.name after reload
fsrc = fsrc.replace(
    'state.user = res.user; $("#auth-dialog")?.close(); await reload();\n'
    '      toast(`Signed in as ${state.user.name}`);',
    'const _gUser = res.user;\n'
    '      state.user = _gUser;\n'
    '      $("#auth-dialog")?.close();\n'
    '      await reload();\n'
    '      toast(`Signed in as ${state.user?.name || _gUser?.name || "you"}`);'
)

assert 'toast(`Signed in as ${state.user.name}`)' not in fsrc, "finder.js onCredential fix failed!"

with open(finder_path, "w", encoding="utf-8") as f:
    f.write(fsrc)

print("[finder.js] Done - %d -> %d bytes" % (foriginal_len, len(fsrc)))
print("All null-guard fixes applied successfully!")
