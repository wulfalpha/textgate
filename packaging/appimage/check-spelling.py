"""Checks that an extracted AppImage's own libenchant finds Hunspell dictionaries.

Usage: python3 -I check-spelling.py <squashfs-root> [language]
The provider must load from inside the AppImage, not from the build machine.
"""
import ctypes
import os
import sys

root = os.path.realpath(sys.argv[1])
language = (sys.argv[2] if len(sys.argv) > 2 else "en_US").encode()
lib = ctypes.CDLL(os.path.join(root, "usr/lib/libenchant-2.so.2"))
lib.enchant_broker_init.restype = ctypes.c_void_p
lib.enchant_broker_dict_exists.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
lib.enchant_broker_describe.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
broker = lib.enchant_broker_init()

providers = []
Describe = ctypes.CFUNCTYPE(None, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p)
describe = Describe(lambda name, desc, path, data: providers.append((name.decode(), path.decode())))
lib.enchant_broker_describe(broker, describe, None)
print("providers:", providers)

problems = []
if not any(name == "hunspell" and os.path.realpath(path).startswith(root + os.sep) for name, path in providers):
    problems.append("the bundled hunspell provider was not loaded")
if any(not os.path.realpath(path).startswith(root + os.sep) for _, path in providers):
    problems.append("a provider was loaded from outside the AppImage")
if not lib.enchant_broker_dict_exists(broker, language):
    problems.append(f"no {language.decode()} dictionary found")
for problem in problems:
    print("error:", problem, file=sys.stderr)
sys.exit(1 if problems else 0)
