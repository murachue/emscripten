/**
 * @license
 * Copyright 2022 The Emscripten Authors
 * SPDX-License-Identifier: MIT
 */

mergeInto(LibraryManager.library, {
  $DENOFS__deps: ['$FS', '$PATH', '$ERRNO_CODES', '$mmapAlloc'],
  $DENOFS__postset: 'if (ENVIRONMENT_IS_DENO) { DENOFS.staticInit(); }',
  $DENOFS: {
    isWindows: false,
    staticInit: () => {
      DENOFS.isWindows = Deno.build.os === "windows";
      DENOFS.openOptionsMap = {
        "{{{ cDefine('O_APPEND') }}}": { append: true },
        "{{{ cDefine('O_CREAT') }}}": { create: true },
        // "{{{ cDefine('O_EXCL') }}}": flags["O_EXCL"],
        // "{{{ cDefine('O_NOCTTY') }}}": flags["O_NOCTTY"],
        "{{{ cDefine('O_RDONLY') }}}": { read: true, write: false },
        "{{{ cDefine('O_RDWR') }}}": { read: true, write: true },
        // "{{{ cDefine('O_DSYNC') }}}": flags["O_SYNC"],
        "{{{ cDefine('O_TRUNC') }}}": { truncate: true },
        "{{{ cDefine('O_WRONLY') }}}": { read: false, write: true },
        // "{{{ cDefine('O_NOFOLLOW') }}}": flags["O_NOFOLLOW"],
      };
    },
    convertDenoCode: (e) => {
      if(e.name === "NotSupported") {
        return {{{ cDefine('ENOSYS') }}};
      }
      var code = e.code;
#if ASSERTIONS
      assert(code in ERRNO_CODES, 'unexpected deno error code: ' + code + ' (' + e + ')');
#endif
      return ERRNO_CODES[code];
    },
    convertDenoMode: (stat) => {
      if (!DENOFS.isWindows) {
        return stat.mode;
      } else {
        // Deno on Windows does not return mode at all.
        // simulate mode using isFile/isDirectory/isSymlink and fixed rwx. (no way to get READONLY or not?)
        return (stat.isFile
          ? 0o100000
          : stat.isDirectory
            ? 0o40000
            : stat.isSymlink
              ? 0o120000
              : 0)
          | 0o777/* S_IRWX{U,G,O} */;
      }
    },
    mount: (mount) => {
#if ASSERTIONS
      assert(ENVIRONMENT_IS_DENO);
#endif
      return DENOFS.createNode(null, '/', DENOFS.getMode(mount.opts.root), 0);
    },
    createNode: (parent, name, mode, dev) => {
      if (!FS.isDir(mode) && !FS.isFile(mode) && !FS.isLink(mode)) {
        throw new FS.ErrnoError({{{ cDefine('EINVAL') }}});
      }
      var node = FS.createNode(parent, name, mode);
      node.node_ops = DENOFS.node_ops;
      node.stream_ops = DENOFS.stream_ops;
      return node;
    },
    getMode: (path) => {
      var stat;
      try {
        stat = Deno.lstatSync(path);
        stat.mode = DENOFS.convertDenoMode(stat);
      } catch (e) {
        if (!e.code) throw e;
        throw new FS.ErrnoError(DENOFS.convertDenoCode(e));
      }
      return stat.mode;
    },
    realPath: (node) => {
      var parts = [];
      while (node.parent !== node) {
        parts.push(node.name);
        node = node.parent;
      }
      parts.push(node.mount.opts.root);
      parts.reverse();
      return PATH.join.apply(null, parts);
    },
    // This maps the integer permission modes from http://linux.die.net/man/3/open
    // to Deno-specific OpenOptions at https://doc.deno.land/deno/stable/~/Deno.OpenOptions
    flagsForDeno: (flags) => {
      flags &= ~{{{ cDefine('O_PATH') }}}; // Ignore this flag from musl, otherwise node.js fails to open the file.
      flags &= ~{{{ cDefine('O_NONBLOCK') }}}; // Ignore this flag from musl, otherwise node.js fails to open the file.
      flags &= ~{{{ cDefine('O_LARGEFILE') }}}; // Ignore this flag from musl, otherwise node.js fails to open the file.
      flags &= ~{{{ cDefine('O_CLOEXEC') }}}; // Some applications may pass it; it makes no sense for a single process.
      flags &= ~{{{ cDefine('O_DIRECTORY') }}}; // Node.js doesn't need this passed in, it errors.
      
      flags &= ~{{{ cDefine('O_EXCL') }}}; // not implemented yet... ignore...
      flags &= ~{{{ cDefine('O_NOCTTY') }}}; // not implemented yet... ignore...
      flags &= ~{{{ cDefine('O_DSYNC') }}}; // not implemented yet... ignore...
      flags &= ~{{{ cDefine('O_NOFOLLOW') }}}; // not implemented yet... ignore...

      var options = {};
      for (var k in DENOFS.openOptionsMap) {
        if (flags & k) {
          Object.assign(options, DENOFS.openOptionsMap[k]);
          flags ^= k;
        }
      }
#if ASSERTIONS
      assert(!flags, 'unknown remain open flags: ' + flags);
#endif
      if (!flags) {
        return options;
      } else {
        throw new FS.ErrnoError({{{ cDefine('EINVAL') }}});
      }
    },
    node_ops: {
      getattr: (node) => {
        var path = DENOFS.realPath(node);
        var stat;
        try {
          stat = Deno.lstatSync(path);
        } catch (e) {
          if (!e.code) throw e;
          throw new FS.ErrnoError(DENOFS.convertDenoCode(e));
        }
        // Deno at least v1.20.4 doesn't report blksize and blocks on Windows. Fake them with default blksize of 4096.
        // See http://support.microsoft.com/kb/140365
        if (DENOFS.isWindows && !stat.blksize) {
          stat.blksize = 4096;
        }
        if (DENOFS.isWindows && !stat.blocks) {
          stat.blocks = (stat.size+stat.blksize-1)/stat.blksize|0;
        }
        // also Deno at least v1.20.4 does not return almost...
        if (DENOFS.isWindows) {
          stat.dev = stat.dev ?? 0; // no way to get volume serial number?
          stat.ino = stat.ino ?? 0; // no way to get file id?
          stat.mode = DENOFS.convertDenoMode(stat);
          stat.nlink = 1;
          stat.uid = 0;
          stat.gid = 0;
          stat.rdev = 0; // it should not device file on Windows... except `??GLOBAL`?
        }
        return {
          dev: stat.dev,
          ino: stat.ino,
          mode: stat.mode,
          nlink: stat.nlink,
          uid: stat.uid,
          gid: stat.gid,
          rdev: stat.rdev,
          size: stat.size,
          atime: stat.atime,
          mtime: stat.mtime,
          ctime: stat.ctime,
          blksize: stat.blksize,
          blocks: stat.blocks
        };
      },
      setattr: (node, attr) => {
        var path = DENOFS.realPath(node);
        try {
          if (attr.mode !== undefined) {
            try {
              Deno.chmodSync(path, attr.mode);
            } catch(e) {
              if (DENOFS.isWindows && e.name === "NotSupported") {
                // ignore!! Deno v1.20.4 does not support chmod at all on Windows yet.
              } else {
                throw e;
              }
            }
            // update the common node structure mode as well
            node.mode = attr.mode;
          }
          // Deno at least v1.20.4 does not have utimes().
          // if (attr.timestamp !== undefined) {
          //   var date = new Date(attr.timestamp);
          //   Deno.utimesSync(path, date, date);
          // }
          if (attr.size !== undefined) {
            Deno.truncateSync(path, attr.size);
          }
        } catch (e) {
          if (!e.code) throw e;
          throw new FS.ErrnoError(DENOFS.convertDenoCode(e));
        }
      },
      lookup: (parent, name) => {
        var path = PATH.join2(DENOFS.realPath(parent), name);
        var mode = DENOFS.getMode(path);
        return DENOFS.createNode(parent, name, mode);
      },
      mknod: (parent, name, mode, dev) => {
        var node = DENOFS.createNode(parent, name, mode, dev);
        // create the backing node for this in the fs root as well
        var path = DENOFS.realPath(node);
        try {
          if (FS.isDir(node.mode)) {
            Deno.mkdirSync(path, { mode: node.mode });
          } else {
            Deno.writeFileSync(path, '', { mode: node.mode });
          }
        } catch (e) {
          if (!e.code) throw e;
          throw new FS.ErrnoError(DENOFS.convertDenoCode(e));
        }
        return node;
      },
      rename: (oldNode, newDir, newName) => {
        var oldPath = DENOFS.realPath(oldNode);
        var newPath = PATH.join2(DENOFS.realPath(newDir), newName);
        try {
          Deno.renameSync(oldPath, newPath);
        } catch (e) {
          if (!e.code) throw e;
          throw new FS.ErrnoError(DENOFS.convertDenoCode(e));
        }
        oldNode.name = newName;
      },
      unlink: (parent, name) => {
        var path = PATH.join2(DENOFS.realPath(parent), name);
        try {
          Deno.removeSync(path);
        } catch (e) {
          if (!e.code) throw e;
          throw new FS.ErrnoError(DENOFS.convertDenoCode(e));
        }
      },
      rmdir: (parent, name) => {
        var path = PATH.join2(DENOFS.realPath(parent), name);
        try {
          Deno.removeSync(path);
        } catch (e) {
          if (!e.code) throw e;
          throw new FS.ErrnoError(DENOFS.convertDenoCode(e));
        }
      },
      readdir: (node) => {
        var path = DENOFS.realPath(node);
        try {
          return [...Deno.readdirSync(path)].map(e => e.name);
        } catch (e) {
          if (!e.code) throw e;
          throw new FS.ErrnoError(DENOFS.convertDenoCode(e));
        }
      },
      symlink: (parent, newName, oldPath) => {
        var newPath = PATH.join2(DENOFS.realPath(parent), newName);
        try {
          Deno.symlinkSync(oldPath, newPath); // TODO: {type: 'file'|'dir'} must be specified on Windows...
        } catch (e) {
          if (!e.code) throw e;
          throw new FS.ErrnoError(DENOFS.convertDenoCode(e));
        }
      },
      readlink: (node) => {
        var path = DENOFS.realPath(node);
        try {
          path = Deno.readLinkSync(path);
          // TODO: implement this. std/path have this but make this async.
          // path = nodePath.relative(nodePath.resolve(node.mount.opts.root), path);
          return path;
        } catch (e) {
          if (!e.code) throw e;
          throw new FS.ErrnoError(DENOFS.convertDenoCode(e));
        }
      },
    },
    stream_ops: {
      open: (stream) => {
        var path = DENOFS.realPath(stream.node);
        try {
          if (FS.isFile(stream.node.mode)) {
            stream.nfd = fs.openSync(path, DENOFS.flagsForDeno(stream.flags));
          }
        } catch (e) {
          if (!e.code) throw e;
          throw new FS.ErrnoError(DENOFS.convertDenoCode(e));
        }
      },
      close: (stream) => {
        try {
          if (FS.isFile(stream.node.mode) && stream.nfd) {
            fs.close(stream.nfd);
          }
        } catch (e) {
          if (!e.code) throw e;
          throw new FS.ErrnoError(DENOFS.convertDenoCode(e));
        }
      },
      read: (stream, buffer, offset, length, position) => {
        try {
          let oldpos = null;
          // node.js v16 document says position is required but it seems optional (vs. fs.writeSync)
          // and FS.read expects position===undefined or number. we accept both.
          if(position === undefined || position === null || position === -1) {
            oldpos = Deno.seekSync(stream.nfd, 0, Deno.SeekMode.Current)
            Deno.seekSync(stream.nfd, position, Deno.SeekMode.Start)
          }
          const readNbytes = Deno.readSync(stream.nfd, new Uint8Array(buffer.buffer, offset, length));
          if (oldpos !== null) {
            // emulate node.js behavior: If position is an integer [except -1], the file position will be unchanged.
            Deno.seekSync(stream.nfd, oldpos, Deno.SeekMode.Start);
          }
          return readNbytes;
        } catch (e) {
          throw new FS.ErrnoError(DENOFS.convertDenoCode(e));
        }
      },
      write: (stream, buffer, offset, length, position) => {
        try {
          let oldpos = null;
          if(typeof position === 'number') {
            oldpos = Deno.seekSync(stream.nfd, 0, Deno.SeekMode.Current)
            Deno.seekSync(stream.nfd, position, Deno.SeekMode.Start)
          }
          const wroteNbytes = fs.writeSync(stream.nfd, new Uint8Array(buffer.buffer, offset, length));
          if (oldpos !== null) {
            // emulate node.js/pwrite(2) behavior: the file position will be unchanged.
            Deno.seekSync(stream.nfd, oldpos, Deno.SeekMode.Start);
          }
          return wroteNbytes;
        } catch (e) {
          throw new FS.ErrnoError(DENOFS.convertDenoCode(e));
        }
      },
      llseek: (stream, offset, whence) => {
        var position = offset;
        if (whence === {{{ cDefine('SEEK_CUR') }}}) {
          position += stream.position;
        } else if (whence === {{{ cDefine('SEEK_END') }}}) {
          if (FS.isFile(stream.node.mode)) {
            try {
              var stat = Deno.fstatSync(stream.nfd);
              position += stat.size;
            } catch (e) {
              throw new FS.ErrnoError(DENOFS.convertDenoCode(e));
            }
          }
        }

        if (position < 0) {
          throw new FS.ErrnoError({{{ cDefine('EINVAL') }}});
        }

        return position;
      },
      mmap: (stream, address, length, position, prot, flags) => {
        if (address !== 0) {
          // We don't currently support location hints for the address of the mapping
          throw new FS.ErrnoError({{{ cDefine('EINVAL') }}});
        }
        if (!FS.isFile(stream.node.mode)) {
          throw new FS.ErrnoError({{{ cDefine('ENODEV') }}});
        }

        var ptr = mmapAlloc(length);

        DENOFS.stream_ops.read(stream, HEAP8, ptr, length, position);
        return { ptr: ptr, allocated: true };
      },
      msync: (stream, buffer, offset, length, mmapFlags) => {
        if (!FS.isFile(stream.node.mode)) {
          throw new FS.ErrnoError({{{ cDefine('ENODEV') }}});
        }
        if (mmapFlags & {{{ cDefine('MAP_PRIVATE') }}}) {
          // MAP_PRIVATE calls need not to be synced back to underlying fs
          return 0;
        }

        var bytesWritten = DENOFS.stream_ops.write(stream, buffer, 0, length, offset, false);
        return 0;
      }
    }
  }
});
