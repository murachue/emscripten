/**
 * @license
 * Copyright 2022 The Emscripten Authors
 * SPDX-License-Identifier: MIT
 */

read_ = function shell_read(filename, binary) {
#if SUPPORT_BASE64_EMBEDDING
  var ret = tryParseAsDataURI(filename);
  if (ret) {
    return binary ? ret : ret.toString();
  }
#endif
//  import {normalize} from "https://deno.land/std@0.137.0/path/mod.ts"; filename = normalize(filename); // why resolve?
  filename = (path => {
    // QUICKHACK
    const filePrefix = Deno.build.os === "windows" ? "file:///" : "file://";
    return path.startsWith(filePrefix) ? path.substr(filePrefix.length) : path;
  })(filename);
  return Deno[binary ? "readFileSync" : "readTextFileSync"](filename);
};

readBinary = (filename) => {
  var ret = read_(filename, true);
#if ASSERTIONS
  assert(ret instanceof Uint8Array);
#endif
  return ret;
};

readAsync = (filename, onload, onerror) => {
#if SUPPORT_BASE64_EMBEDDING
  var ret = tryParseAsDataURI(filename);
  if (ret) {
    onload(ret);
  }
#endif
//  import {normalize} from "https://deno.land/std@0.137.0/path/mod.ts"; filename = normalize(filename); // why resolve?
  filename = (path => {
    // QUICKHACK
    const filePrefix = Deno.build.os === "windows" ? "file:///" : "file://";
    return path.startsWith(filePrefix) ? path.substr(filePrefix.length) : path;
  })(filename);
  Deno.readFile(filename).then(onload, err);
};
