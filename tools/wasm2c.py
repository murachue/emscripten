# Copyright 2020 The Emscripten Authors.  All rights reserved.
# Emscripten is available under two separate licenses, the MIT license and the
# University of Illinois/NCSA Open Source License.  Both these licenses can be
# found in the LICENSE file.

import os
import re

from tools.shared import unsuffixed, check_call
from tools.settings import settings
from tools.utils import path_from_root, exit_with_error
from tools import config


# map an emscripten-style signature letter to a wasm2c C type
def s_to_c(s):
  if s == 'v':
    return 'void'
  elif s == 'i':
    return 'u32'
  elif s == 'j':
    return 'u64'
  elif s == 'f':
    return 'f32'
  elif s == 'd':
    return 'f64'
  else:
    exit_with_error('invalid sig element:' + str(s))


# map a wasm2c C type to an emscripten-style signature letter
def c_to_s(c):
  if c == 'WASM_RT_I32':
    return 'i'
  elif c == 'WASM_RT_I64':
    return 'j'
  elif c == 'WASM_RT_F32':
    return 'f'
  elif c == 'WASM_RT_F64':
    return 'd'
  else:
    exit_with_error('invalid wasm2c type element:' + str(c))


def get_func_types(code):
  '''
    We look for this pattern:

    static void init_func_types(void) {
      func_types[0] = wasm_rt_register_func_type(3, 1, WASM_RT_I32, WASM_RT_I32, WASM_RT_I32, WASM_RT_I32);
      func_types[1] = wasm_rt_register_func_type(1, 1, WASM_RT_I32, WASM_RT_I32);
      func_types[2] = wasm_rt_register_func_type(0, 0);
    }

    We return a map of signatures names to their index.
  '''
  init_func_types = re.search(r'static void init_func_types\(void\) {([^}]*)}', code)
  if not init_func_types:
    return {}
  ret = {}
  for entry in re.findall(r'func_types\[(\d+)\] = wasm_rt_register_func_type\((\d+), (\d+),? ?([^)]+)?\);', init_func_types[0]):
    index, params, results, types = entry
    index = int(index)
    params = int(params)
    results = int(results)
    types = types.split(', ')
    sig = ''
    for i in range(params):
      sig += c_to_s(types[i])
    if results == 0:
      sig = 'v' + sig
    else:
      assert results == 1, 'no multivalue support'
      sig = c_to_s(types[-1]) + sig
    ret[sig] = index
  return ret


def do_wasm2c(infile):
  assert settings.STANDALONE_WASM
  WASM2C = config.NODE_JS + [path_from_root('node_modules/wasm2c/wasm2c.js')]
  WASM2C_DIR = path_from_root('node_modules/wasm2c')
  c_file = unsuffixed(infile) + '.wasm.c'
  h_file = unsuffixed(infile) + '.wasm.h'
  cmd = WASM2C + [infile, '-o', c_file]
  check_call(cmd)
  total = '''\
/*
 * This file was generated by emcc+wasm2c. To compile it, use something like
 *
 *   $CC FILE.c -O2 -lm -DWASM_RT_MAX_CALL_STACK_DEPTH=8000
 */
'''
  SEP = '\n/* ==================================== */\n'

  def bundle_file(filename):
    nonlocal total
    with open(filename) as f:
      total += '// ' + filename + '\n' + f.read() + SEP

  # hermeticize the C file, by bundling in the wasm2c/ includes
  headers = [
    (WASM2C_DIR, 'wasm-rt.h'),
    (WASM2C_DIR, 'wasm-rt-impl.h'),
    ('', h_file)
  ]
  for header in headers:
    bundle_file(os.path.join(header[0], header[1]))
  # add the wasm2c output
  bundle_file(c_file)
  # add the wasm2c runtime
  bundle_file(os.path.join(WASM2C_DIR, 'wasm-rt-impl.c'))
  # add the support code
  support_files = ['base.c']
  if settings.AUTODEBUG:
    support_files.append('autodebug.c')
  if settings.EXPECT_MAIN:
    # TODO: add an option for direct OS access. For now, do that when building
    #       an executable with main, as opposed to a library
    support_files.append('os.c')
    support_files.append('main.c')
  else:
    support_files.append('os_sandboxed.c')
    support_files.append('reactor.c')
    # for a reactor, also append wasmbox_* API definitions
    with open(h_file, 'a') as f:
      f.write('''
// wasmbox_* API
// TODO: optional prefixing
extern void wasmbox_init(void);
''')
  for support_file in support_files:
    bundle_file(path_from_root(f'tools/wasm2c/{support_file}'))
  # remove #includes of the headers we bundled
  for header in headers:
    total = total.replace('#include "%s"\n' % header[1], '/* include of %s */\n' % header[1])
  # generate the necessary invokes
  invokes = []
  for sig in re.findall(r"\/\* import\: 'env' 'invoke_(\w+)' \*\/", total):
    all_func_types = get_func_types(total)

    def name(i):
      return 'a' + str(i)

    wabt_sig = sig[0] + 'i' + sig[1:]
    typed_args = [s_to_c(sig[i]) + ' ' + name(i) for i in range(1, len(sig))]
    full_typed_args = ['u32 fptr'] + typed_args
    types = [s_to_c(sig[i]) for i in range(1, len(sig))]
    args = [name(i) for i in range(1, len(sig))]
    c_func_type = s_to_c(sig[0]) + ' (*)(' + (', '.join(types) if types else 'void') + ')'
    if sig not in all_func_types:
      exit_with_error('could not find signature ' + sig + ' in function types ' + str(all_func_types))
    type_index = all_func_types[sig]

    invokes.append(r'''
IMPORT_IMPL(%(return_type)s, Z_envZ_invoke_%(sig)sZ_%(wabt_sig)s, (%(full_typed_args)s), {
  VERBOSE_LOG("invoke\n"); // waka
  u32 sp = WASM_RT_ADD_PREFIX(Z_stackSaveZ_iv)();
  if (next_setjmp >= MAX_SETJMP_STACK) {
    abort_with_message("too many nested setjmps");
  }
  u32 id = next_setjmp++;
  int result = setjmp(setjmp_stack[id]);
  %(declare_return)s
  if (result == 0) {
    %(receive)sCALL_INDIRECT(w2c___indirect_function_table, %(c_func_type)s, %(type_index)s, fptr %(args)s);
    /* if we got here, no longjmp or exception happened, we returned normally */
  } else {
    /* A longjmp or an exception took us here. */
    WASM_RT_ADD_PREFIX(Z_stackRestoreZ_vi)(sp);
    WASM_RT_ADD_PREFIX(Z_setThrewZ_vii)(1, 0);
  }
  next_setjmp--;
  %(return)s
});
''' % {
      'return_type': s_to_c(sig[0]) if sig[0] != 'v' else 'void',
      'sig': sig,
      'wabt_sig': wabt_sig,
      'full_typed_args': ', '.join(full_typed_args),
      'type_index': type_index,
      'c_func_type': c_func_type,
      'args': (', ' + ', '.join(args)) if args else '',
      'declare_return': (s_to_c(sig[0]) + ' returned_value = 0;') if sig[0] != 'v' else '',
      'receive': 'returned_value = ' if sig[0] != 'v' else '',
      'return': 'return returned_value;' if sig[0] != 'v' else ''
    })

  total += '\n'.join(invokes)

  # adjust sandboxing
  TRAP_OOB = 'TRAP(OOB)'
  assert total.count(TRAP_OOB) == 2
  if settings.WASM2C_SANDBOXING == 'full':
    pass # keep it
  elif settings.WASM2C_SANDBOXING == 'none':
    total = total.replace(TRAP_OOB, '{}')
  elif settings.WASM2C_SANDBOXING == 'mask':
    assert not settings.ALLOW_MEMORY_GROWTH
    assert (settings.INITIAL_MEMORY & (settings.INITIAL_MEMORY - 1)) == 0, 'poewr of 2'
    total = total.replace(TRAP_OOB, '{}')
    MEM_ACCESS = '[addr]'
    assert total.count(MEM_ACCESS) == 3, '2 from wasm2c, 1 from runtime'
    total = total.replace(MEM_ACCESS, '[addr & %d]' % (settings.INITIAL_MEMORY - 1))
  else:
    exit_with_error('bad sandboxing')

  # adjust prefixing: emit simple output that works with multiple libraries,
  # each compiled into its own single .c file, by adding 'static' in some places
  # TODO: decide on the proper pattern for this in an upstream discussion in
  #       wasm2c; another option would be to prefix all these things.
  for rep in [
    'uint32_t wasm_rt_register_func_type(',
    'void wasm_rt_trap(',
    'void wasm_rt_allocate_memory(',
    'uint32_t wasm_rt_grow_memory(',
    'void wasm_rt_allocate_table(',
    'jmp_buf g_jmp_buf',
    'uint32_t g_func_type_count',
    'FuncType* g_func_types',
    'uint32_t wasm_rt_call_stack_depth',
    'uint32_t g_saved_call_stack_depth',
  ]:
    # remove 'extern' from declaration
    total = total.replace('extern ' + rep, rep)
    # add 'static' to implementation
    old = total
    total = total.replace(rep, 'static ' + rep)
    assert old != total, f'did not find "{rep}"'

  # write out the final file
  with open(c_file, 'w') as out:
    out.write(total)
