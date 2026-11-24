import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);

const socketPattern =
  /^(?:run\/mcp\/(?:alexosMemory|appStoreConnect|blender|coolify|cops|discord|docuseal|gsc|notion|openseo|polar|sentry)\.sock|plugins\/resources\/host-data\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/gate)$/;

const number = z.number().int().nonnegative().safe();

const bindingSchema = z
  .object({
    path: z.string(),
    sourcePath: z.string(),
    device: z.string().regex(/^\d+$/),
    inode: z.string().regex(/^\d+$/),
    uid: number,
    gid: number,
    mode: number,
  })
  .strict();

const countsSchema = z
  .object({
    entries: number,
    directories: number,
    regularFiles: number,
    symbolicLinks: number,
    sockets: number,
    logicalBytes: number,
    hardlinkAliases: number,
    largestRegularFileBytes: number,
  })
  .strict();

const identitySchema = z
  .object({ device: z.string(), inode: z.string(), uid: number })
  .strict();

const summarySchema = z
  .object({
    counts: countsSchema,
    socketBindings: z.array(bindingSchema).max(65536),
    unsupported: z
      .array(z.object({ path: z.string(), kind: z.string() }).strict())
      .max(256),
    unsupportedCount: number,
    metadataDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const traversalSchema = z
  .object({
    stack: z.array(z.unknown()).max(256),
    hardlinks: z.record(z.string(), z.unknown()),
    summary: summarySchema,
  })
  .strict();

const fileBindingSchema = z
  .object({
    device: z.string(),
    inode: z.string(),
    uid: number,
    gid: number,
    mode: number,
    size: number,
    mtimeNs: z.string(),
    ctimeNs: z.string(),
    nlink: number,
  })
  .strict();

const configDigestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z
    .object({
      kind: z.literal("normalized"),
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
      binding: fileBindingSchema,
    })
    .strict(),
]);

const digestOptionsSchema = z
  .object({
    config: configDigestSchema,
    durable: z.boolean(),
    bridge: z
      .object({
        root: z.string(),
        bindings: z.array(bindingSchema).max(65536),
        identity: identitySchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

const fingerprintSchema = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    metadataDigest: z.string().regex(/^[a-f0-9]{64}$/),
    files: number,
    bytes: number,
    bytesHashed: number,
  })
  .strict();

const word = z.number().int().min(0).max(0xffffffff);

const contentSchema = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    files: number,
    bytes: number,
    bytesHashed: number,
    partial: z
      .object({
        path: z.string(),
        metadata: z.array(z.union([z.string(), number])),
        offset: number,
        count: z.array(word).length(2),
        hash: z.array(word).length(8),
      })
      .strict()
      .nullable(),
  })
  .strict();

const digestTraversalSchema = traversalSchema
  .extend({ content: contentSchema })
  .strict();

const treeCheckpointSchema = z
  .object({
    schema: z.literal(1),
    operation: z.enum(["inspect", "copy"]),
    source: z.string(),
    destination: z.string(),
    sourceIdentity: identitySchema,
    destinationIdentity: identitySchema.nullable(),
    parentIdentity: identitySchema,
    phase: z.enum(["preflight", "copy", "verify", "complete"]),
    traversal: traversalSchema.nullable(),
    baseline: summarySchema.nullable(),
    inFlight: z.boolean(),
  })
  .strict();

const digestCheckpointSchema = treeCheckpointSchema
  .extend({
    operation: z.literal("digest"),
    digestOptions: digestOptionsSchema,
    traversal: digestTraversalSchema.nullable(),
    fingerprint: fingerprintSchema.nullable(),
  })
  .strict();

const checkpointSchema = z.union([
  treeCheckpointSchema,
  digestCheckpointSchema,
]);

const nativeSchema = z
  .object({
    complete: z.boolean(),
    traversal: traversalSchema,
    destinationIdentity: identitySchema.nullable(),
  })
  .strict();

const digestNativeSchema = nativeSchema
  .extend({ traversal: digestTraversalSchema })
  .strict();

const script = String.raw`
import base64,ctypes,hashlib,json,os,pwd,re,stat,sys
def failure(kind,value,traceback):
 code=str(value) if isinstance(value,RuntimeError) and re.fullmatch(r"[a-z-]+",str(value)) else str(value.errno) if isinstance(value,OSError) and isinstance(value.errno,int) else "native-error"
 print("OMNYO_NATIVE_FAILURE:"+kind.__name__+":"+code,file=sys.stderr)
sys.excepthook=failure
lib=ctypes.CDLL("/usr/lib/libSystem.B.dylib",use_errno=True)
lib.fclonefileat.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint32];lib.fclonefileat.restype=ctypes.c_int
lib.clonefileat.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint32];lib.clonefileat.restype=ctypes.c_int
lib.fcopyfile.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_void_p,ctypes.c_uint32];lib.fcopyfile.restype=ctypes.c_int
pattern=re.compile(r"(?:run/mcp/(?:alexosMemory|appStoreConnect|blender|coolify|cops|discord|docuseal|gsc|notion|openseo|polar|sentry)\.sock|plugins/resources/host-data/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gate)\Z")
request=json.load(sys.stdin)
mode=request["mode"];source=request["source"];destination=request["destination"]
inherited_gid=request.get("inheritedGid");settable_gids=set(os.getgroups())|set(os.getgrouplist(pwd.getpwuid(os.geteuid()).pw_name,os.getegid()))|{os.getegid()}
digesting=mode in ("digest","digest-verify")
if digesting:
 class SHA256Context(ctypes.Structure):_fields_=[("count",ctypes.c_uint32*2),("hash",ctypes.c_uint32*8),("wbuf",ctypes.c_uint32*16)]
 if ctypes.sizeof(SHA256Context)!=104:raise RuntimeError("digest-abi")
 lib.CC_SHA256_Init.argtypes=[ctypes.POINTER(SHA256Context)];lib.CC_SHA256_Init.restype=ctypes.c_int
 lib.CC_SHA256_Update.argtypes=[ctypes.POINTER(SHA256Context),ctypes.c_void_p,ctypes.c_uint32];lib.CC_SHA256_Update.restype=ctypes.c_int
 lib.CC_SHA256_Final.argtypes=[ctypes.c_void_p,ctypes.POINTER(SHA256Context)];lib.CC_SHA256_Final.restype=ctypes.c_int
uid=os.getuid();flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
def identity(info):return {"device":str(info.st_dev),"inode":str(info.st_ino),"uid":info.st_uid}
def metadata(info):return [str(info.st_dev),str(info.st_ino),info.st_mode,info.st_uid,info.st_gid,info.st_size,str(info.st_mtime_ns),str(info.st_ctime_ns),info.st_nlink]
def same(info,expected):
 if metadata(info)!=expected:raise RuntimeError("source-drift")
def same_directory(info,expected):
 actual=metadata(info)
 different=actual[:5]!=expected[:5] if digesting else actual!=expected
 if different:raise RuntimeError("source-drift")
def file_binding(info):return {"device":str(info.st_dev),"inode":str(info.st_ino),"uid":info.st_uid,"gid":info.st_gid,"mode":stat.S_IMODE(info.st_mode),"size":info.st_size,"mtimeNs":str(info.st_mtime_ns),"ctimeNs":str(info.st_ctime_ns),"nlink":info.st_nlink}
def validate_config(root):
 selected=request["digestOptions"]["config"]
 try:info=os.stat(b"config.json",dir_fd=root,follow_symlinks=False)
 except FileNotFoundError:
  if selected["kind"]=="absent":return
  raise RuntimeError("config-binding")
 if selected["kind"]!="normalized" or not stat.S_ISREG(info.st_mode) or info.st_uid!=uid or file_binding(info)!=selected["binding"]:raise RuntimeError("config-binding")
def owned(info):
 if info.st_uid!=uid:raise RuntimeError("ownership")
def preserve_metadata(sourcefd,targetfd,info):
 if lib.fcopyfile(sourcefd,targetfd,None,7)!=0:raise RuntimeError("native-metadata")
 target=os.fstat(targetfd)
 if (target.st_uid,target.st_gid)!=(info.st_uid,info.st_gid):os.fchown(targetfd,info.st_uid,info.st_gid)
 if stat.S_IMODE(os.fstat(targetfd).st_mode)!=stat.S_IMODE(info.st_mode):os.fchmod(targetfd,stat.S_IMODE(info.st_mode))
 target=os.fstat(targetfd)
 if (target.st_uid,target.st_gid,stat.S_IMODE(target.st_mode))!=(info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode)):raise RuntimeError("permission-drift")
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
def parent(root,path):
 safe(path);directory,_,name=path.rpartition("/")
 return descend(root,directory),os.fsencode(name)
def binding(path,info,root=source):return {"path":path,"sourcePath":root+"/"+path,"device":str(info.st_dev),"inode":str(info.st_ino),"uid":info.st_uid,"gid":info.st_gid,"mode":stat.S_IMODE(info.st_mode)}
def validate_binding(root,item,root_path=source):
 path=safe(item["path"])
 if not pattern.fullmatch(path) or item["sourcePath"]!=root_path+"/"+path:raise RuntimeError("socket-binding")
 fd,name=parent(root,path)
 try:
  info=os.stat(name,dir_fd=fd,follow_symlinks=False)
  if not stat.S_ISSOCK(info.st_mode) or binding(path,info,root_path)!=item or info.st_uid!=uid:raise RuntimeError("socket-drift")
 finally:os.close(fd)
def check_root(path,expected):
 fd=os.open(path,flags);info=os.fstat(fd);owned(info)
 if identity(info)!=expected:os.close(fd);raise RuntimeError("root-drift")
 return fd
sourcefd=check_root(source,request["sourceIdentity"])
destinationfd=None
bridgefd=None;bridges={};hashed_bytes=0
def advance(previous,record):return hashlib.sha256(bytes.fromhex(previous)+json.dumps(record,separators=(",",":"),ensure_ascii=True).encode()).hexdigest()
def directory_record(path,info):return ["directory",path,str(info.st_dev),str(info.st_ino),info.st_mode,info.st_uid,info.st_gid]
def content_record(content,record):content["digest"]=advance(content["digest"],record)
def hash_file(fd,path,original,content):
 global hashed_bytes
 partial=content["partial"];context=SHA256Context();offset=0
 if partial is not None:
  if partial["path"]!=path or partial["metadata"]!=original or partial["offset"]%1048576:raise RuntimeError("digest-cursor-drift")
  offset=partial["offset"];context.count[:]=partial["count"];context.hash[:]=partial["hash"]
  if offset>=original[5]:raise RuntimeError("digest-cursor-drift")
 else:
  if lib.CC_SHA256_Init(ctypes.byref(context))!=1:raise RuntimeError("digest-init")
 os.lseek(fd,offset,os.SEEK_SET)
 while offset<original[5] and hashed_bytes<268435456:
  block=os.read(fd,min(1048576,original[5]-offset))
  if not block:raise RuntimeError("digest-read-drift")
  if lib.CC_SHA256_Update(ctypes.byref(context),block,len(block))!=1:raise RuntimeError("digest-update")
  offset+=len(block);hashed_bytes+=len(block);content["bytesHashed"]+=len(block)
 same(os.fstat(fd),original)
 if offset<original[5]:
  if offset%1048576:raise RuntimeError("digest-alignment")
  content["partial"]={"path":path,"metadata":original,"offset":offset,"count":list(context.count),"hash":list(context.hash)}
  return None
 output=ctypes.create_string_buffer(32)
 if lib.CC_SHA256_Final(output,ctypes.byref(context))!=1:raise RuntimeError("digest-final")
 content["partial"]=None
 return output.raw.hex()
try:
 if digesting:
  validate_config(sourcefd)
  bridge=request["digestOptions"]["bridge"]
  if bridge is not None:
   bridgefd=check_root(bridge["root"],bridge["identity"])
   bridges={item["path"]:item for item in bridge["bindings"]}
   if len(bridges)!=len(bridge["bindings"]):raise RuntimeError("socket-binding")
   for item in bridges.values():validate_binding(bridgefd,item,bridge["root"])
 if mode=="bridges":
  destinationfd=check_root(destination,request["destinationIdentity"])
  for item in request["bindings"]:
   validate_binding(sourcefd,item);fd,name=parent(destinationfd,item["path"])
   try:
    info=os.stat(name,dir_fd=fd,follow_symlinks=False)
    if not stat.S_ISLNK(info.st_mode) or info.st_uid!=uid or os.readlink(name,dir_fd=fd)!=os.fsencode(item["sourcePath"]):raise RuntimeError("bridge-drift")
   finally:os.close(fd)
  print("{}")
 else:
  traversal=request["traversal"]
  if mode=="copy":
   for item in request["expectedBindings"]:validate_binding(sourcefd,item)
   if request["destinationIdentity"] is None:
    parentfd=os.open(os.path.dirname(destination),flags)
    try:
     if identity(os.fstat(parentfd))!=request["destinationParentIdentity"]:raise RuntimeError("destination-parent-drift")
     os.mkdir(os.fsencode(os.path.basename(destination)),0o700,dir_fd=parentfd)
     destinationfd=os.open(os.fsencode(os.path.basename(destination)),flags,dir_fd=parentfd)
    finally:os.close(parentfd)
   else:
    destinationfd=check_root(destination,request["destinationIdentity"])
    if traversal is None:
     with os.scandir(destinationfd) as entries:
      if next(entries,None) is not None:raise RuntimeError("staging-not-empty")
  root_unchecked=traversal is None
  if traversal is None:
   traversal={"stack":[{"path":"","after":None,"metadata":metadata(os.fstat(sourcefd))}],"hardlinks":{},"summary":{"counts":{"entries":1,"directories":1,"regularFiles":0,"symbolicLinks":0,"sockets":0,"logicalBytes":0,"hardlinkAliases":0,"largestRegularFileBytes":0},"socketBindings":[],"unsupported":[],"unsupportedCount":0,"metadataDigest":"0"*64}}
   record=["",metadata(os.fstat(sourcefd)),None]
   traversal["summary"]["metadataDigest"]=hashlib.sha256(bytes(32)+json.dumps(record,separators=(",",":"),ensure_ascii=True).encode()).hexdigest()
   if digesting:
    root_info=os.fstat(sourcefd)
    traversal["summary"]["metadataDigest"]=advance("0"*64,directory_record("",root_info))
    traversal["content"]={"digest":advance("0"*64,["directory","",stat.S_IMODE(root_info.st_mode),root_info.st_uid,root_info.st_gid]),"files":0,"bytes":0,"bytesHashed":0,"partial":None}
  summary=traversal["summary"];counts=summary["counts"];stack=traversal["stack"];hardlinks=traversal["hardlinks"]
  def unsupported(path,kind):
   summary["unsupportedCount"]+=1
   if len(summary["unsupported"])<256:summary["unsupported"].append({"path":path,"kind":kind})
  if root_unchecked and inherited_gid is not None:
   root_gid=os.fstat(sourcefd).st_gid
   if root_gid!=inherited_gid and root_gid not in settable_gids:unsupported(".","group")
  processed=0;directory_cache={};cached_names=0
  while stack and processed<2048:
   if len(stack)>256 or len(hardlinks)>65536:raise RuntimeError("shard-bound")
   frame=stack[-1];directory=frame["path"]
   if directory:safe(directory)
   fd=descend(sourcefd,directory);destfd=None
   try:
    same_directory(os.fstat(fd),frame["metadata"])
    if mode=="copy":destfd=descend(destinationfd,directory)
    names=directory_cache.get(directory)
    if names is None:
     with os.scandir(fd) as iterator:
      names=[]
      for entry in iterator:
       names.append(entry.name)
       if len(names)>65536:raise RuntimeError("directory-bound")
     names.sort()
     while directory_cache and cached_names+len(names)>65536:
      discarded=next(iter(directory_cache));cached_names-=len(directory_cache.pop(discarded))
     directory_cache[directory]=names;cached_names+=len(names)
    after=frame["after"]
    remaining=[name for name in names if after is None or name>after]
    descended=False
    paused=False
    for name in remaining:
     if processed>=2048:break
     encoded=os.fsencode(name);path=directory+"/"+name if directory else name;safe(path)
     info=os.stat(encoded,dir_fd=fd,follow_symlinks=False);original=metadata(info);link=None
     if counts["entries"]>=1048576:raise RuntimeError("tree-bound")
     if stat.S_ISREG(info.st_mode) and counts["logicalBytes"]+info.st_size>68719476736:raise RuntimeError("byte-bound")
     if stat.S_ISLNK(info.st_mode):link=base64.b64encode(os.readlink(encoded,dir_fd=fd)).decode("ascii")
     file_hash=None;bridge_item=bridges.get(path);meta_record=[path,original,link];synced=False
     if digesting:
      if path=="config.json":
       selected=request["digestOptions"]["config"]
       if selected["kind"]!="normalized" or not stat.S_ISREG(info.st_mode) or file_binding(info)!=selected["binding"]:raise RuntimeError("config-binding")
       file_hash=selected["sha256"]
       meta_record=None if file_hash is None else ["config",path,stat.S_IMODE(info.st_mode),info.st_uid,info.st_gid,file_hash]
      elif stat.S_ISDIR(info.st_mode):meta_record=directory_record(path,info)
      elif bridge_item is not None:
       if not stat.S_ISLNK(info.st_mode) or os.readlink(encoded,dir_fd=fd)!=os.fsencode(bridge_item["sourcePath"]):raise RuntimeError("bridge-drift")
       validate_binding(bridgefd,bridge_item,bridge["root"]);meta_record=["socket",bridge_item]
      elif stat.S_ISSOCK(info.st_mode) and pattern.fullmatch(path):meta_record=["socket",binding(path,info)]
      elif stat.S_ISREG(info.st_mode) and mode=="digest":
       owned(info);existing=hardlinks.get(str(info.st_dev)+":"+str(info.st_ino)) if info.st_nlink>1 else None
       if existing is not None:file_hash=existing["fileDigest"]
       else:
        filefd=os.open(encoded,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
        try:
         same(os.fstat(filefd),original);file_hash=hash_file(filefd,path,original,traversal["content"])
         if file_hash is not None and request["digestOptions"]["durable"]:os.fsync(filefd);same(os.fstat(filefd),original);synced=True
        finally:os.close(filefd)
        if file_hash is None:paused=True;break
     if meta_record is not None:summary["metadataDigest"]=advance(summary["metadataDigest"],meta_record)
     if digesting and request["digestOptions"]["durable"] and stat.S_ISREG(info.st_mode) and not synced:
      syncfd=os.open(encoded,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
      try:same(os.fstat(syncfd),original);os.fsync(syncfd);same(os.fstat(syncfd),original)
      finally:os.close(syncfd)
     counts["entries"]+=1;processed+=1;frame["after"]=name
     if counts["entries"]>1048576:raise RuntimeError("tree-bound")
     if info.st_uid!=uid:unsupported(path,"unowned")
     elif inherited_gid is not None and info.st_gid!=inherited_gid and not (stat.S_ISSOCK(info.st_mode) and pattern.fullmatch(path)) and (stat.S_ISLNK(info.st_mode) or info.st_gid not in settable_gids):unsupported(path,"group")
     if digesting:
      content=traversal["content"]
      if stat.S_ISDIR(info.st_mode):content_record(content,["directory",path,stat.S_IMODE(info.st_mode),info.st_uid,info.st_gid])
      elif bridge_item is not None:content_record(content,["socket",path,bridge_item["uid"],bridge_item["gid"],bridge_item["mode"]])
      elif stat.S_ISLNK(info.st_mode):content_record(content,["link",path,link])
      elif stat.S_ISSOCK(info.st_mode) and pattern.fullmatch(path):content_record(content,["socket",path,info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode)])
      elif stat.S_ISREG(info.st_mode) and (path!="config.json" or file_hash is not None):
       if mode=="digest":content_record(content,["file",path,stat.S_IMODE(info.st_mode),info.st_uid,info.st_gid,file_hash])
       content["files"]+=1
       if path!="config.json":content["bytes"]+=info.st_size
     if stat.S_ISDIR(info.st_mode):
      counts["directories"]+=1
      if mode=="copy":
       owned(info);os.mkdir(encoded,0o700,dir_fd=destfd)
      stack.append({"path":path,"after":None,"metadata":original});descended=True;break
     elif stat.S_ISREG(info.st_mode):
      counts["regularFiles"]+=1;counts["logicalBytes"]+=info.st_size
      counts["largestRegularFileBytes"]=max(counts["largestRegularFileBytes"],info.st_size)
      if counts["logicalBytes"]>68719476736:raise RuntimeError("byte-bound")
      key=str(info.st_dev)+":"+str(info.st_ino);previous=hardlinks.get(key) if info.st_nlink>1 else None
      if previous is not None:
       counts["hardlinkAliases"]+=1
       if previous["metadata"]!=original:raise RuntimeError("hardlink-drift")
      if mode=="copy":
       owned(info);filefd=os.open(encoded,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
       try:
        same(os.fstat(filefd),original)
        if previous is None:
         if lib.fclonefileat(filefd,destfd,encoded,4)!=0:raise RuntimeError("native-clone")
         targetfd=os.open(encoded,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=destfd)
         try:
          if identity(os.fstat(targetfd))==identity(info):raise RuntimeError("source-hardlink")
          preserve_metadata(filefd,targetfd,info)
          targetIdentity=identity(os.fstat(targetfd))
         finally:os.close(targetfd)
        else:
         previousfd,previousname=parent(destinationfd,previous["path"])
         try:
          targetinfo=os.stat(previousname,dir_fd=previousfd,follow_symlinks=False)
          if not stat.S_ISREG(targetinfo.st_mode) or identity(targetinfo)!=previous["destinationIdentity"] or identity(targetinfo)==identity(info):raise RuntimeError("hardlink-destination-drift")
          os.link(previousname,encoded,src_dir_fd=previousfd,dst_dir_fd=destfd,follow_symlinks=False)
         finally:os.close(previousfd)
        same(os.fstat(filefd),original)
       finally:os.close(filefd)
      if info.st_nlink>1 and previous is None:
       hardlinks[key]={"path":path,"metadata":original,"destinationIdentity":targetIdentity if mode=="copy" else None}
       if mode=="digest":hardlinks[key]["fileDigest"]=file_hash
       if len(hardlinks)>65536:raise RuntimeError("shard-bound")
     elif stat.S_ISLNK(info.st_mode):
      counts["symbolicLinks"]+=1
      if mode=="copy":
       owned(info)
       if lib.clonefileat(fd,encoded,destfd,encoded,1|4|8)!=0:raise RuntimeError("native-link-clone")
       if os.readlink(encoded,dir_fd=destfd)!=base64.b64decode(link):raise RuntimeError("link-drift")
       copied=os.stat(encoded,dir_fd=destfd,follow_symlinks=False)
       if (copied.st_uid,copied.st_gid,stat.S_IMODE(copied.st_mode))!=(info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode)):raise RuntimeError("link-permission-drift")
     elif stat.S_ISSOCK(info.st_mode):
      counts["sockets"]+=1
      if pattern.fullmatch(path):
       item=binding(path,info);summary["socketBindings"].append(item)
       if len(summary["socketBindings"])>65536:raise RuntimeError("socket-bound")
       if mode=="copy":
        owned(info);validate_binding(sourcefd,item);os.symlink(os.fsencode(item["sourcePath"]),encoded,dir_fd=destfd)
        validate_binding(sourcefd,item)
      else:unsupported(path,"socket")
     else:unsupported(path,"fifo" if stat.S_ISFIFO(info.st_mode) else "device" if stat.S_ISCHR(info.st_mode) or stat.S_ISBLK(info.st_mode) else "special")
     same(os.stat(encoded,dir_fd=fd,follow_symlinks=False),original)
     if mode=="copy" and summary["unsupportedCount"]:raise RuntimeError("unsupported-kind")
    same_directory(os.fstat(fd),frame["metadata"])
    if not paused and not descended and (not remaining or frame["after"]==remaining[-1]):
     if mode=="copy":preserve_metadata(fd,destfd,os.fstat(fd))
     if digesting and request["digestOptions"]["durable"]:os.fsync(fd);same_directory(os.fstat(fd),frame["metadata"])
     stack.pop()
   finally:
    if destfd is not None:os.close(destfd)
    os.close(fd)
   if paused:break
  if mode=="copy":
   for item in request["expectedBindings"]:validate_binding(sourcefd,item)
  if digesting:
   validate_config(sourcefd)
   for item in bridges.values():validate_binding(bridgefd,item,bridge["root"])
  print(json.dumps({"complete":not stack,"traversal":traversal,"destinationIdentity":identity(os.fstat(destinationfd)) if destinationfd is not None else request["destinationIdentity"]},separators=(",",":"),ensure_ascii=True))
finally:
 os.close(sourcefd)
 if destinationfd is not None:os.close(destinationfd)
 if bridgefd is not None:os.close(bridgefd)
`;

export function isOmnyoStateSocketPathV1(path) {
  return socketPattern.exec(path)?.[0] === path;
}

function within(root, path) {
  const value = relative(root, path);

  return (
    value === "" ||
    (!value.startsWith("../") && value !== ".." && !isAbsolute(value))
  );
}

async function exactDirectory(path) {
  if (
    process.platform !== "darwin" ||
    !isAbsolute(path) ||
    resolve(path) !== path
  )
    throw new Error(
      "Omnyo state tree requires the existing Mac filesystem owner",
    );
  const info = await lstat(path, { bigint: true });

  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== BigInt(process.getuid()) ||
    (await realpath(path)) !== path
  )
    throw new Error("Omnyo state tree requires an exact owned directory");

  return {
    device: String(info.dev),
    inode: String(info.ino),
    uid: Number(info.uid),
  };
}

async function native(request, timeout = 15000) {
  try {
    const child = execute("/usr/bin/python3", ["-I", "-c", script], {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin" },
    });

    child.child.stdin.end(JSON.stringify(request));
    const result = await child;

    return JSON.parse(result.stdout);
  } catch (error) {
    const message =
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string"
        ? error.stderr
            .match(/OMNYO_NATIVE_FAILURE:([A-Za-z]+):([a-z-]+|\d+)/)
            ?.slice(1)
            .join("-")
        : undefined;

    throw new Error(
      `Omnyo native state tree ${message ?? "transfer-or-verification"} refused; original state and staging were preserved`,
    );
  }
}

function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function stateFile(
  source,
  destination,
  operation,
  checkpointPath,
  digestOptions = null,
) {
  const [sourceIdentity, parentIdentity] = await Promise.all([
    exactDirectory(source),
    exactDirectory(dirname(checkpointPath)),
  ]);

  if (
    !isAbsolute(checkpointPath) ||
    resolve(checkpointPath) !== checkpointPath ||
    within(source, checkpointPath) ||
    (destination &&
      (within(destination, checkpointPath) ||
        within(source, destination) ||
        within(destination, source)))
  )
    throw new Error(
      "Omnyo state checkpoint must be outside the disjoint source and staging roots",
    );

  if (
    operation === "copy" &&
    (!isAbsolute(destination) || resolve(destination) !== destination)
  )
    throw new Error("Omnyo state staging requires an absolute canonical path");
  let destinationIdentity = null;

  if (operation === "copy") {
    try {
      destinationIdentity = await exactDirectory(destination);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
  }

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

    const initial = {
      schema: 1,
      operation,
      source,
      destination,
      sourceIdentity,
      destinationIdentity,
      parentIdentity,
      phase: "preflight",
      traversal: null,
      baseline: null,
      inFlight: false,
    };

    const state =
      operation === "digest"
        ? { ...initial, digestOptions, fingerprint: null }
        : initial;

    return { file, state };
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
      throw new Error("Omnyo state checkpoint ownership or bounds changed");

    const state = checkpointSchema.parse(
      JSON.parse(await file.readFile("utf8")),
    );

    if (
      state.source !== source ||
      state.destination !== destination ||
      state.operation !== operation ||
      !equal(state.sourceIdentity, sourceIdentity) ||
      !equal(state.parentIdentity, parentIdentity) ||
      (state.inFlight && operation !== "digest")
    )
      throw new Error(
        "Omnyo state checkpoint binding changed or an interrupted shard needs inspection",
      );

    if (
      state.destinationIdentity &&
      !equal(state.destinationIdentity, await exactDirectory(destination))
    )
      throw new Error("Omnyo state staging identity changed");

    if (operation === "digest") {
      if (
        !equivalentConfig(state.digestOptions.config, digestOptions.config) ||
        !equal(state.digestOptions.bridge, digestOptions.bridge) ||
        state.digestOptions.durable !== digestOptions.durable
      )
        throw new Error(
          "Omnyo digest configuration or bridge binding changed; use a fresh checkpoint",
        );
      state.digestOptions = digestOptions;
      state.inFlight = false;
    }

    return { file, state };
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function persist(file, state, checkpointPath) {
  const [info, named] = await Promise.all([file.stat(), lstat(checkpointPath)]);

  if (
    info.dev !== named.dev ||
    info.ino !== named.ino ||
    named.isSymbolicLink() ||
    named.uid !== process.getuid() ||
    named.nlink !== 1 ||
    (named.mode & 0o777) !== 0o600
  )
    throw new Error("Omnyo state checkpoint was replaced");
  const bytes = Buffer.from(JSON.stringify(state));

  if (bytes.length > 16 * 1024 * 1024)
    throw new Error("Omnyo state checkpoint exceeds its bound");
  await file.write(bytes, 0, bytes.length, 0);
  await file.truncate(bytes.length);
  await file.sync();
}

async function run(source, destination, operation, options) {
  const deadline = performance.now() + 49000;

  const maxShards = z
    .number()
    .int()
    .min(1)
    .max(1024)
    .parse(options.maxShards ?? 1024);

  const { file, state } = await stateFile(
    source,
    destination,
    operation,
    options.checkpointPath,
  );

  try {
    if (state.phase === "complete") {
      state.phase = operation === "copy" ? "verify" : "preflight";
      state.traversal = null;

      if (operation === "inspect") state.baseline = null;
    }

    await persist(file, state, options.checkpointPath);
    let shards = 0;

    while (
      state.phase !== "complete" &&
      performance.now() < deadline - 15000 &&
      shards < maxShards
    ) {
      shards++;

      const destinationParentIdentity =
        operation === "copy"
          ? await exactDirectory(dirname(destination))
          : null;

      const inheritedGid = (
        await lstat(
          operation === "copy"
            ? dirname(destination)
            : dirname(options.checkpointPath),
        )
      ).gid;

      state.inFlight = true;
      await persist(file, state, options.checkpointPath);

      const result = nativeSchema.parse(
        await native(
          {
            mode: state.phase === "copy" ? "copy" : "inspect",
            source,
            destination,
            sourceIdentity: state.sourceIdentity,
            destinationIdentity: state.destinationIdentity,
            destinationParentIdentity,
            inheritedGid,
            expectedBindings: state.baseline?.socketBindings ?? [],
            traversal: state.traversal,
          },
          Math.min(
            15000,
            Math.max(1, Math.floor(deadline - performance.now())),
          ),
        ),
      );

      state.traversal = result.traversal;
      state.destinationIdentity = result.destinationIdentity;
      state.inFlight = false;

      if (result.complete) {
        const summary = result.traversal.summary;

        if (state.phase === "preflight") {
          state.baseline = summary;

          if (operation === "inspect") state.phase = "complete";
          else {
            if (summary.unsupportedCount) {
              await persist(file, state, options.checkpointPath);
              throw new Error(
                "Omnyo state tree contains unsupported kinds or ownership; no staging was created",
              );
            }

            state.phase = "copy";
            state.traversal = null;
          }
        } else if (state.phase === "copy") {
          if (!equal(summary, state.baseline))
            throw new Error("Omnyo state source changed during copying");
          state.phase = "verify";
          state.traversal = null;
        } else {
          if (!equal(summary, state.baseline))
            throw new Error("Omnyo state source changed after copying");
          await native(
            {
              mode: "bridges",
              source,
              destination,
              sourceIdentity: state.sourceIdentity,
              destinationIdentity: state.destinationIdentity,
              bindings: summary.socketBindings,
            },
            Math.min(
              15000,
              Math.max(1, Math.floor(deadline - performance.now())),
            ),
          );
          state.phase = "complete";
        }
      }

      await persist(file, state, options.checkpointPath);
    }

    const summary = state.baseline ?? state.traversal?.summary;

    if (!summary)
      throw new Error("Omnyo state tree did not produce its bounded inventory");

    return {
      ...summary,
      complete: state.phase === "complete",
      continuationPath:
        state.phase === "complete" ? null : options.checkpointPath,
      phase: state.phase,
      phaseEntries: state.traversal?.summary.counts.entries ?? 0,
      phaseBytes: state.traversal?.summary.counts.logicalBytes ?? 0,
    };
  } finally {
    await file.close();
  }
}

export async function inspectOmnyoStateTreeKindsV1(source, options) {
  return run(source, "", "inspect", options);
}

export async function copyOmnyoStateTreeV1(source, destination, options) {
  return run(source, destination, "copy", options);
}

export async function validateOmnyoSocketBridgesV1(
  source,
  destination,
  bindings,
) {
  const [sourceIdentity, destinationIdentity] = await Promise.all([
    exactDirectory(source),
    exactDirectory(destination),
  ]);

  await native({
    mode: "bridges",
    source,
    destination,
    sourceIdentity,
    destinationIdentity,
    bindings: z.array(bindingSchema).max(65536).parse(bindings),
  });
}

function equivalentConfig(before, after) {
  if (before.kind === "absent")
    return after.kind === "absent" || after.sha256 === null;

  if (after.kind === "absent") return before.sha256 === null;

  return (
    before.sha256 === after.sha256 &&
    before.binding.mode === after.binding.mode &&
    before.binding.uid === after.binding.uid &&
    before.binding.gid === after.binding.gid
  );
}

export async function inspectOmnyoStateTreeDigestV1(source, options) {
  const deadline = performance.now() + 49000;

  const maxShards = z
    .number()
    .int()
    .min(1)
    .max(1024)
    .parse(options.maxShards ?? 1024);

  const config = configDigestSchema.parse(options.config);

  const bridge =
    options.socketBridgeSource === undefined
      ? null
      : {
          root: options.socketBridgeSource.root,
          bindings: z
            .array(bindingSchema)
            .max(65536)
            .parse(options.socketBridgeSource.bindings),
          identity: await exactDirectory(options.socketBridgeSource.root),
        };

  const digestOptions = digestOptionsSchema.parse({
    config,
    bridge,
    durable: options.durable ?? false,
  });

  const { file, state } = await stateFile(
    source,
    "",
    "digest",
    options.checkpointPath,
    digestOptions,
  );

  try {
    if (state.phase === "complete") {
      state.phase = "verify";
      state.traversal = null;
    }

    await persist(file, state, options.checkpointPath);
    let shards = 0;
    let bytesReadThisCall = 0;

    while (
      state.phase !== "complete" &&
      shards < maxShards &&
      performance.now() < deadline - 15000
    ) {
      shards++;
      state.inFlight = true;
      await persist(file, state, options.checkpointPath);
      const previousBytes = state.traversal?.content.bytesHashed ?? 0;

      const result = digestNativeSchema.parse(
        await native(
          {
            mode: state.phase === "verify" ? "digest-verify" : "digest",
            source,
            destination: "",
            sourceIdentity: state.sourceIdentity,
            destinationIdentity: null,
            traversal: state.traversal,
            digestOptions,
          },
          Math.min(
            15000,
            Math.max(1, Math.floor(deadline - performance.now())),
          ),
        ),
      );

      bytesReadThisCall += result.traversal.content.bytesHashed - previousBytes;
      state.traversal = result.traversal;
      state.inFlight = false;

      if (result.traversal.summary.unsupportedCount)
        throw new Error("Omnyo digest refuses unsupported kinds or ownership");

      if (result.complete) {
        if (state.phase === "verify") {
          if (
            state.fingerprint === null ||
            result.traversal.summary.metadataDigest !==
              state.fingerprint.metadataDigest
          )
            throw new Error(
              "Omnyo digest source metadata changed; use a fresh checkpoint",
            );
          state.phase = "complete";
        } else {
          const content = result.traversal.content;
          state.fingerprint = {
            digest: content.digest,
            metadataDigest: result.traversal.summary.metadataDigest,
            files: content.files,
            bytes: content.bytes,
            bytesHashed: content.bytesHashed,
          };
          state.phase = "verify";
          state.traversal = null;
        }
      }

      await persist(file, state, options.checkpointPath);
    }

    const fingerprint = state.phase === "complete" ? state.fingerprint : null;
    const content = state.traversal?.content;

    return {
      algorithm: "state-tree-v2",
      complete: state.phase === "complete",
      continuationPath:
        state.phase === "complete" ? null : options.checkpointPath,
      digest: fingerprint?.digest ?? null,
      metadataDigest: fingerprint?.metadataDigest ?? null,
      files:
        fingerprint?.files ?? content?.files ?? state.fingerprint?.files ?? 0,
      bytes:
        fingerprint?.bytes ?? content?.bytes ?? state.fingerprint?.bytes ?? 0,
      bytesHashed: state.fingerprint?.bytesHashed ?? content?.bytesHashed ?? 0,
      bytesReadThisCall,
      phaseEntries: state.traversal?.summary.counts.entries ?? 0,
      phaseBytes: state.traversal?.summary.counts.logicalBytes ?? 0,
    };
  } finally {
    await file.close();
  }
}
