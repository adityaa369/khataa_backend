import re

with open(r'c:\Users\adity\AndroidStudioProjects\khatha\lib\core\utils\secure_storage.dart', 'r', encoding='utf-8') as f:
    c = f.read()

replacement = """  // Clear auth credentials and sensitive caches to prevent cross-user leakage
  static Future<void> clearAuthData() async {
    await _storage.delete(key: _tokenKey);
    await _storage.delete(key: _refreshTokenKey);
    await _storage.delete(key: _userKey);
    await _storage.delete(key: _biometricEnabledKey);
    await _storage.delete(key: _lastLoginKey);
    // MUST clear financial caches
    await _storage.delete(key: _loansKey);
    await _storage.delete(key: _vacantChitsKey);
    await _storage.delete(key: _myInvitesKey);
    await _storage.delete(key: _myChitsKey);
  }"""

c = re.sub(r'  // Clear only auth credentials.*?\}', replacement, c, flags=re.DOTALL)

with open(r'c:\Users\adity\AndroidStudioProjects\khatha\lib\core\utils\secure_storage.dart', 'w', encoding='utf-8') as f:
    f.write(c)
