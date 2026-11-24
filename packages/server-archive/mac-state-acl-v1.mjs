import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);

const catalogSchema = z.array(
  z.object({ path: z.string(), acl: z.string() }).strict(),
);

const script = String.raw`
import base64,ctypes,errno,json,os,stat,sys
lib=ctypes.CDLL("/usr/lib/libSystem.B.dylib",use_errno=True)
for name in ("acl_get_file","acl_get_link_np"):
 f=getattr(lib,name);f.argtypes=[ctypes.c_char_p,ctypes.c_int];f.restype=ctypes.c_void_p
for name in ("acl_set_file","acl_set_link_np"):
 f=getattr(lib,name);f.argtypes=[ctypes.c_char_p,ctypes.c_int,ctypes.c_void_p];f.restype=ctypes.c_int
lib.acl_free.argtypes=[ctypes.c_void_p];lib.acl_free.restype=ctypes.c_int
lib.acl_init.argtypes=[ctypes.c_int];lib.acl_init.restype=ctypes.c_void_p
lib.acl_size.argtypes=[ctypes.c_void_p];lib.acl_size.restype=ctypes.c_ssize_t
lib.acl_copy_ext_native.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_ssize_t];lib.acl_copy_ext_native.restype=ctypes.c_ssize_t
mode,source,target=sys.argv[1:]
paths=[""]
for directory,dirs,files in os.walk(source,followlinks=False):
 for name in sorted(dirs+files):paths.append(os.path.relpath(os.path.join(directory,name),source))
 if len(paths)>65536:raise RuntimeError("Mac ACL inventory exceeds its bound")
def read(path):
 before=os.lstat(path)
 symbolic=stat.S_ISLNK(before.st_mode)
 acl=(lib.acl_get_link_np if symbolic else lib.acl_get_file)(os.fsencode(path),256)
 if not acl:
  if ctypes.get_errno()==errno.ENOENT:
   after=os.lstat(path)
   if (before.st_dev,before.st_ino)==(after.st_dev,after.st_ino):return None,b"",symbolic
  raise RuntimeError("Mac ACL read refused")
 size=lib.acl_size(acl)
 if size<=0 or size>65536:lib.acl_free(acl);raise RuntimeError("Mac ACL size refused")
 buf=ctypes.create_string_buffer(size)
 written=lib.acl_copy_ext_native(buf,acl,size)
 if written<0 or written>size:lib.acl_free(acl);raise RuntimeError("Mac ACL encoding refused")
 return acl,buf.raw[:written],symbolic
records=[]
for relative in paths:
 path=os.path.join(source,relative)
 acl,raw,symbolic=read(path)
 try:
  if mode=="copy":
   destination=os.path.join(target,relative)
   existing,other,dest_symbolic=read(destination)
   try:
    if symbolic!=dest_symbolic:raise RuntimeError("Mac clone file type differs")
    if raw!=other:
     selected=acl if acl else lib.acl_init(0)
     if not selected:raise RuntimeError("Mac empty ACL allocation refused")
     try:
      if (lib.acl_set_link_np if symbolic else lib.acl_set_file)(os.fsencode(destination),256,selected)!=0:raise RuntimeError("Mac ACL copy refused")
     finally:
      if not acl:lib.acl_free(selected)
   finally:lib.acl_free(existing)
  else:records.append({"path":relative,"acl":base64.b64encode(raw).decode("ascii")})
 finally:lib.acl_free(acl)
print(json.dumps(records,separators=(",",":")))
`;

async function ownedRoot(path) {
  if (
    process.platform !== "darwin" ||
    !isAbsolute(path) ||
    resolve(path) !== path
  )
    throw new Error("Mac ACL transfer requires its existing filesystem owner");
  const info = await lstat(path);

  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (await realpath(path)) !== path
  )
    throw new Error("Mac ACL transfer requires an exact owned directory");
}

async function native(mode, source, target) {
  try {
    const result = await execute(
      "/usr/bin/python3",
      ["-I", "-c", script, mode, source, target],
      {
        timeout: 15000,
        maxBuffer: 16 * 1024 * 1024,
        env: { PATH: "/usr/bin:/bin" },
      },
    );

    return catalogSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw new Error(
      "Native Mac ACL transfer or verification failed; original state was preserved",
    );
  }
}

export async function inspectMacStateAclV1(root) {
  await ownedRoot(root);

  return (await native("inspect", root, "")).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

export async function copyMacStateAclV1(source, destination) {
  await Promise.all([ownedRoot(source), ownedRoot(destination)]);
  await native("copy", source, destination);

  const [before, after] = await Promise.all([
    inspectMacStateAclV1(source),
    inspectMacStateAclV1(destination),
  ]);

  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("Mac clone ACLs differ from their exact source owner");
}

const integerSchema = z.number().int().nonnegative().safe();

const identitySchema = z
  .object({ device: z.string(), inode: z.string(), uid: integerSchema })
  .strict();

const socketSchema = z
  .object({
    path: z.string(),
    sourcePath: z.string(),
    device: z.string().regex(/^\d+$/),
    inode: z.string().regex(/^\d+$/),
    uid: integerSchema,
    gid: integerSchema,
    mode: integerSchema,
  })
  .strict();

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const traversalSchema = z
  .object({
    stack: z
      .array(
        z
          .object({
            path: z.string(),
            after: z.string().nullable(),
            metadata: z.string(),
          })
          .strict(),
      )
      .max(256),
    entries: integerSchema,
    bridges: integerSchema,
    digest: digestSchema,
  })
  .strict();

const checkpointSchema = z
  .object({
    schema: z.literal(1),
    source: z.string(),
    destination: z.string(),
    sourceIdentity: identitySchema,
    destinationIdentity: identitySchema,
    parentIdentity: identitySchema,
    socketBindings: z.array(socketSchema).max(65536),
    phase: z.enum(["copy", "verify", "complete"]),
    traversal: traversalSchema.nullable(),
    baseline: z
      .object({ entries: integerSchema, digest: digestSchema })
      .strict()
      .nullable(),
    inFlight: z.boolean(),
  })
  .strict();

const shardSchema = z
  .object({
    complete: z.boolean(),
    processed: integerSchema,
    traversal: traversalSchema,
  })
  .strict();

const treeScript = String.raw`
import base64,ctypes,errno,hashlib,json,os,re,stat,sys,time
request=json.load(sys.stdin)
lib=ctypes.CDLL("/usr/lib/libSystem.B.dylib",use_errno=True)
lib.acl_get_fd_np.argtypes=[ctypes.c_int,ctypes.c_int];lib.acl_get_fd_np.restype=ctypes.c_void_p
lib.acl_set_fd_np.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_int];lib.acl_set_fd_np.restype=ctypes.c_int
lib.acl_get_link_np.argtypes=[ctypes.c_char_p,ctypes.c_int];lib.acl_get_link_np.restype=ctypes.c_void_p
lib.acl_set_link_np.argtypes=[ctypes.c_char_p,ctypes.c_int,ctypes.c_void_p];lib.acl_set_link_np.restype=ctypes.c_int
lib.acl_get_file.argtypes=[ctypes.c_char_p,ctypes.c_int];lib.acl_get_file.restype=ctypes.c_void_p
lib.acl_free.argtypes=[ctypes.c_void_p];lib.acl_free.restype=ctypes.c_int
lib.acl_init.argtypes=[ctypes.c_int];lib.acl_init.restype=ctypes.c_void_p
lib.acl_size.argtypes=[ctypes.c_void_p];lib.acl_size.restype=ctypes.c_ssize_t
lib.acl_copy_ext_native.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_ssize_t];lib.acl_copy_ext_native.restype=ctypes.c_ssize_t
pattern=re.compile(r"(?:run/mcp/(?:alexosMemory|appStoreConnect|blender|coolify|cops|discord|docuseal|gsc|notion|openseo|polar|sentry)\.sock|plugins/resources/host-data/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gate)\Z")
uid=os.getuid();flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
source=request["source"];destination=request["destination"];copy=request["phase"]=="copy"
def identity(info):return {"device":str(info.st_dev),"inode":str(info.st_ino),"uid":info.st_uid}
def owned(info):
 if info.st_uid!=uid:raise RuntimeError("ownership")
def metadata(info):return json.dumps([str(info.st_dev),str(info.st_ino),info.st_mode,info.st_uid,info.st_gid,str(info.st_mtime_ns),str(info.st_ctime_ns)],separators=(",",":"))
def safe(path):
 if not isinstance(path,str) or path.startswith("/") or any(p in ("",".","..") for p in path.split("/")):raise RuntimeError("checkpoint-path")
 return path

def descend(root,path):
 fd=os.dup(root)
 try:
  if path:
   for part in safe(path).split("/"):
    nextfd=os.open(os.fsencode(part),flags,dir_fd=fd);os.close(fd);fd=nextfd;owned(os.fstat(fd))
  return fd
 except:
  os.close(fd);raise

def root(path,expected):
 fd=os.open(path,flags);info=os.fstat(fd);owned(info)
 if identity(info)!=expected:os.close(fd);raise RuntimeError("root-drift")
 return fd

def acl(parent,name,info):
 fd=None;symbolic=stat.S_ISLNK(info.st_mode);socket=stat.S_ISSOCK(info.st_mode)
 if symbolic or socket:
  os.fchdir(parent)
  value=(lib.acl_get_link_np if symbolic else lib.acl_get_file)(name,256)
 else:
  fd=os.dup(parent) if name is None else os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
  if metadata(os.fstat(fd))!=metadata(info):os.close(fd);raise RuntimeError("entry-drift")
  value=lib.acl_get_fd_np(fd,256)
 if not value:
  if ctypes.get_errno()!=errno.ENOENT:
   if fd is not None:os.close(fd)
   raise RuntimeError("acl-read")
  return None,b"",fd
 size=lib.acl_size(value)
 if size<=0 or size>65536:lib.acl_free(value);raise RuntimeError("acl-size")
 buffer=ctypes.create_string_buffer(size);written=lib.acl_copy_ext_native(buffer,value,size)
 if written<0 or written>size:lib.acl_free(value);raise RuntimeError("acl-encoding")
 return value,buffer.raw[:written],fd

def close(value,fd):
 if value:lib.acl_free(value)
 if fd is not None:os.close(fd)

def state(parent,name):return os.fstat(parent) if name is None else os.stat(name,dir_fd=parent,follow_symlinks=False)

def bridge(path,info,other,sourceParent,destinationParent,name):
 item=bindings.get(path)
 expected={"path":path,"sourcePath":source+"/"+path,"device":str(info.st_dev),"inode":str(info.st_ino),"uid":info.st_uid,"gid":info.st_gid,"mode":stat.S_IMODE(info.st_mode)}
 if item!=expected or not pattern.fullmatch(path) or not stat.S_ISSOCK(info.st_mode):raise RuntimeError("socket-binding")
 if not stat.S_ISLNK(other.st_mode) or os.readlink(name,dir_fd=destinationParent)!=os.fsencode(item["sourcePath"]):raise RuntimeError("bridge-drift")
 if metadata(state(sourceParent,name))!=metadata(info) or metadata(state(destinationParent,name))!=metadata(other):raise RuntimeError("socket-drift")

bindings={}
for item in request["socketBindings"]:
 path=safe(item["path"])
 if path in bindings or not pattern.fullmatch(path) or item["sourcePath"]!=source+"/"+path:raise RuntimeError("socket-binding")
 bindings[path]=item
sourcefd=root(source,request["sourceIdentity"]);destinationfd=root(destination,request["destinationIdentity"])
try:
 traversal=request["traversal"]
 if traversal is None:traversal={"stack":[{"path":"","after":None,"metadata":metadata(os.fstat(sourcefd))}],"entries":0,"bridges":0,"digest":"0"*64}
 stack=traversal["stack"];processed=0;deadline=time.monotonic()+11
 def entry(path,sourceParent,destinationParent,name):
  info=state(sourceParent,name);other=state(destinationParent,name);owned(info);owned(other)
  isbridge=path in bindings or stat.S_ISSOCK(info.st_mode)
  if isbridge:
   bridge(path,info,other,sourceParent,destinationParent,name);traversal["bridges"]+=1
  else:
   if stat.S_IFMT(info.st_mode)!=stat.S_IFMT(other.st_mode) or stat.S_IMODE(info.st_mode)!=stat.S_IMODE(other.st_mode) or info.st_gid!=other.st_gid:raise RuntimeError("entry-type-or-mode")
   if (info.st_dev,info.st_ino)==(other.st_dev,other.st_ino):raise RuntimeError("source-alias")
   if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):raise RuntimeError("unsupported-kind")
   if stat.S_ISLNK(info.st_mode) and os.readlink(name,dir_fd=sourceParent)!=os.readlink(name,dir_fd=destinationParent):raise RuntimeError("link-drift")
  original,raw,fd=acl(sourceParent,name,info)
  try:
   if not isbridge:
    existing,otherraw,destfd=acl(destinationParent,name,other)
    try:
     if raw!=otherraw:
      if not copy:raise RuntimeError("acl-mismatch")
      selected=original or lib.acl_init(0)
      if not selected:raise RuntimeError("acl-empty")
      try:
       if stat.S_ISLNK(info.st_mode):
        os.fchdir(destinationParent);result=lib.acl_set_link_np(name,256,selected)
       else:result=lib.acl_set_fd_np(destfd,selected,256)
       if result!=0:raise RuntimeError("acl-copy")
      finally:
       if not original:lib.acl_free(selected)
    finally:close(existing,destfd)
    checked,checkedraw,checkedfd=acl(destinationParent,name,state(destinationParent,name))
    try:
     if checkedraw!=raw:raise RuntimeError("acl-mismatch")
    finally:close(checked,checkedfd)
   if metadata(state(sourceParent,name))!=metadata(info):raise RuntimeError("source-drift")
   if isbridge:bridge(path,info,other,sourceParent,destinationParent,name)
   elif identity(state(destinationParent,name))!=identity(other):raise RuntimeError("destination-drift")
   link=base64.b64encode(os.readlink(name,dir_fd=sourceParent)).decode("ascii") if stat.S_ISLNK(info.st_mode) else None
   record=[path,metadata(info),hashlib.sha256(raw).hexdigest(),link]
   traversal["digest"]=hashlib.sha256(bytes.fromhex(traversal["digest"])+json.dumps(record,separators=(",",":"),ensure_ascii=True).encode()).hexdigest();traversal["entries"]+=1
   return info
  finally:close(original,fd)
 if traversal["entries"]==0:
  entry("",sourcefd,destinationfd,None);processed+=1
 while stack and processed<request["maxEntries"] and time.monotonic()<deadline:
  if len(stack)>256:raise RuntimeError("depth-bound")
  frame=stack[-1];directory=frame["path"];fd=descend(sourcefd,directory);destfd=descend(destinationfd,directory)
  try:
   if metadata(os.fstat(fd))!=frame["metadata"]:raise RuntimeError("source-directory-drift")
   def names(root):
    values=[]
    with os.scandir(root) as iterator:
     for item in iterator:
      values.append(item.name)
      if len(values)>65536:raise RuntimeError("directory-bound")
    return sorted(values)
   children=names(fd)
   if children!=names(destfd):raise RuntimeError("directory-entries-differ")
   remaining=[name for name in children if frame["after"] is None or name>frame["after"]];descended=False
   for name in remaining:
    if processed>=request["maxEntries"] or time.monotonic()>=deadline:break
    path=directory+"/"+name if directory else name;safe(path)
    info=entry(path,fd,destfd,os.fsencode(name));processed+=1;frame["after"]=name
    if stat.S_ISDIR(info.st_mode):stack.append({"path":path,"after":None,"metadata":metadata(info)});descended=True;break
   if metadata(os.fstat(fd))!=frame["metadata"]:raise RuntimeError("source-directory-drift")
   if not descended and (not remaining or frame["after"]==children[-1]):stack.pop()
  finally:os.close(fd);os.close(destfd)
 if not stack and traversal["bridges"]!=len(bindings):raise RuntimeError("socket-binding-count")
 print(json.dumps({"complete":not stack,"processed":processed,"traversal":traversal},separators=(",",":"),ensure_ascii=True))
finally:os.close(sourcefd);os.close(destinationfd)
`;

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function within(root, path) {
  const value = relative(root, path);

  return (
    value === "" ||
    (!value.startsWith("../") && value !== ".." && !isAbsolute(value))
  );
}

async function treeIdentity(path) {
  await ownedRoot(path);
  const info = await lstat(path, { bigint: true });

  return {
    device: String(info.dev),
    inode: String(info.ino),
    uid: Number(info.uid),
  };
}

async function treeCheckpoint(source, destination, options) {
  const checkpointPath = options.checkpointPath;

  if (
    !isAbsolute(checkpointPath) ||
    resolve(checkpointPath) !== checkpointPath ||
    within(source, checkpointPath) ||
    within(destination, checkpointPath) ||
    within(source, destination) ||
    within(destination, source)
  )
    throw new Error(
      "Mac ACL checkpoint requires an external protected job and disjoint roots",
    );

  const [sourceIdentity, destinationIdentity, parentIdentity, parent] =
    await Promise.all([
      treeIdentity(source),
      treeIdentity(destination),
      treeIdentity(dirname(checkpointPath)),
      lstat(dirname(checkpointPath)),
    ]);

  if ((parent.mode & 0o777) !== 0o700)
    throw new Error(
      "Mac ACL checkpoint parent must be protected with mode 0700",
    );

  const socketBindings = z
    .array(socketSchema)
    .max(65536)
    .parse(options.socketBindings ?? []);

  let file;

  try {
    file = await open(
      checkpointPath,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );

    return {
      file,
      state: {
        schema: 1,
        source,
        destination,
        sourceIdentity,
        destinationIdentity,
        parentIdentity,
        socketBindings,
        phase: "copy",
        traversal: null,
        baseline: null,
        inFlight: false,
      },
    };
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
  }

  file = await open(checkpointPath, constants.O_RDWR | constants.O_NOFOLLOW);

  try {
    const info = await file.stat();

    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o777) !== 0o600 ||
      info.nlink !== 1 ||
      info.size > 16 * 1024 * 1024
    )
      throw new Error("Mac ACL checkpoint ownership or bounds changed");

    const state = checkpointSchema.parse(
      JSON.parse(await file.readFile("utf8")),
    );

    if (
      state.source !== source ||
      state.destination !== destination ||
      !same(state.sourceIdentity, sourceIdentity) ||
      !same(state.destinationIdentity, destinationIdentity) ||
      !same(state.parentIdentity, parentIdentity) ||
      !same(state.socketBindings, socketBindings) ||
      state.inFlight
    )
      throw new Error(
        "Mac ACL checkpoint binding changed or an interrupted shard needs inspection",
      );

    if (state.phase === "complete") {
      state.phase = "verify";
      state.traversal = null;
    }

    return { file, state };
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function persistTree(file, state, checkpointPath) {
  const [info, named, parentIdentity] = await Promise.all([
    file.stat(),
    lstat(checkpointPath),
    treeIdentity(dirname(checkpointPath)),
  ]);

  if (
    info.dev !== named.dev ||
    info.ino !== named.ino ||
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.uid !== process.getuid() ||
    named.nlink !== 1 ||
    (named.mode & 0o777) !== 0o600 ||
    !same(parentIdentity, state.parentIdentity)
  )
    throw new Error("Mac ACL checkpoint was replaced");
  const bytes = Buffer.from(JSON.stringify(state));

  if (bytes.length > 16 * 1024 * 1024)
    throw new Error("Mac ACL checkpoint exceeds its bound");
  await file.write(bytes, 0, bytes.length, 0);
  await file.truncate(bytes.length);
  await file.sync();
}

async function nativeTree(request, timeout) {
  try {
    const child = execute("/usr/bin/python3", ["-I", "-c", treeScript], {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin" },
    });

    child.child.stdin.end(JSON.stringify(request));

    return shardSchema.parse(JSON.parse((await child).stdout));
  } catch (error) {
    const reason =
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string"
        ? error.stderr.match(/RuntimeError: ([a-z-]+)/)?.[1]
        : undefined;

    throw new Error(
      `Native Mac ACL tree ${reason ?? "transfer-or-verification"} refused; original state and checkpoint were preserved`,
    );
  }
}

export async function copyMacStateAclTreeV1(source, destination, options) {
  const deadline = performance.now() + 48000;

  const limit = z
    .number()
    .int()
    .min(1)
    .max(65536)
    .parse(options.maxEntriesPerCall ?? 65536);

  const { file, state } = await treeCheckpoint(source, destination, options);
  let processed = 0;

  try {
    await persistTree(file, state, options.checkpointPath);

    while (
      state.phase !== "complete" &&
      processed < limit &&
      performance.now() < deadline - 15000
    ) {
      state.inFlight = true;
      await persistTree(file, state, options.checkpointPath);

      const result = await nativeTree(
        {
          source,
          destination,
          sourceIdentity: state.sourceIdentity,
          destinationIdentity: state.destinationIdentity,
          socketBindings: state.socketBindings,
          phase: state.phase,
          traversal: state.traversal,
          maxEntries: Math.min(2048, limit - processed),
        },
        15000,
      );

      state.inFlight = false;
      state.traversal = result.traversal;
      processed += result.processed;

      if (result.complete) {
        const summary = {
          entries: result.traversal.entries,
          digest: result.traversal.digest,
        };

        if (state.phase === "copy") {
          state.baseline = summary;
          state.phase = "verify";
          state.traversal = null;
        } else {
          if (!same(summary, state.baseline))
            throw new Error(
              "Mac clone ACL tree changed during final verification",
            );
          state.phase = "complete";
        }
      }

      await persistTree(file, state, options.checkpointPath);
    }

    return {
      complete: state.phase === "complete",
      continuationPath:
        state.phase === "complete" ? null : options.checkpointPath,
      phase: state.phase,
      entriesVerified: state.traversal?.entries ?? 0,
      aclDigest:
        state.traversal?.digest ?? state.baseline?.digest ?? "0".repeat(64),
    };
  } finally {
    await file.close();
  }
}
