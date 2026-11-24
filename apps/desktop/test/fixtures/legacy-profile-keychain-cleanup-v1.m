#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>
#include <node_api.h>
#include <math.h>

static NSString *const expectedCodeHash=@"09273391f6cce1ca12557b7949f04dac957a30f8";
static NSString *const fixtureName=@"Omnyo Profile Legacy Fixture";
static BOOL exactOwner() {
  SecCodeRef code=NULL;
  CFDictionaryRef raw=NULL;
  if (SecCodeCopySelf(kSecCSDefaultFlags,&code)) return NO;
  OSStatus result=SecCodeCheckValidity(code,kSecCSStrictValidate,NULL);
  if (!result) result=SecCodeCopySigningInformation(code,kSecCSSigningInformation,&raw);
  CFRelease(code);
  if (result || !raw) return NO;
  NSDictionary *info=CFBridgingRelease(raw);
  NSData *codeHash=info[(__bridge NSString *)kSecCodeInfoUnique];
  NSMutableString *actual=[NSMutableString string];
  for (NSUInteger n=0;n<codeHash.length;n++) [actual appendFormat:@"%02x",((const unsigned char *)codeHash.bytes)[n]];
  return [actual isEqual:expectedCodeHash] && [info[(__bridge NSString *)kSecCodeInfoIdentifier] isEqual:@"Electron"];
}
static NSMutableDictionary *query() {
  LAContext *context=[[LAContext alloc] init];
  context.interactionNotAllowed=YES;
  return [@{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService:[fixtureName stringByAppendingString:@" Safe Storage"],
    (__bridge id)kSecAttrAccount:[fixtureName stringByAppendingString:@" Key"],
    (__bridge id)kSecUseAuthenticationUI:(__bridge id)kSecUseAuthenticationUIFail,
    (__bridge id)kSecUseAuthenticationContext:context} mutableCopy];
}
static BOOL uiDisabled() {
  Boolean allowed=true;
  return SecKeychainSetUserInteractionAllowed(false)==errSecSuccess && SecKeychainGetUserInteractionAllowed(&allowed)==errSecSuccess && !allowed;
}
static BOOL number(napi_env env,napi_value object,const char *name,double value) {
  napi_value encoded;
  return napi_create_double(env,value,&encoded)==napi_ok && napi_set_named_property(env,object,name,encoded)==napi_ok;
}
static BOOL boolean(napi_env env,napi_value object,const char *name,BOOL value) {
  napi_value encoded;
  return napi_get_boolean(env,value ? true : false,&encoded)==napi_ok && napi_set_named_property(env,object,name,encoded)==napi_ok;
}
static napi_value inspectOrRemove(napi_env env,napi_callback_info callback,BOOL remove) {
  @autoreleasepool {
    if (!exactOwner() || !uiDisabled()) { napi_throw_error(env,NULL,"Exact legacy fixture owner and UI-fail fence are required"); return NULL; }
    double expectedCreated=0,expectedModified=0;
    if (remove) {
      napi_value values[2];size_t count=2;
      if (napi_get_cb_info(env,callback,&count,values,NULL,NULL)!=napi_ok || count!=2 || napi_get_value_double(env,values[0],&expectedCreated)!=napi_ok || napi_get_value_double(env,values[1],&expectedModified)!=napi_ok || expectedCreated<=0 || expectedModified<=0) {
        napi_throw_error(env,NULL,"Exact attested fixture creation metadata is required"); return NULL;
      }
    }
    NSMutableDictionary *lookup=query();
    lookup[(__bridge id)kSecReturnAttributes]=@YES;
    lookup[(__bridge id)kSecReturnPersistentRef]=@YES;
    lookup[(__bridge id)kSecMatchLimit]=(__bridge id)kSecMatchLimitAll;
    CFTypeRef raw=NULL;
    OSStatus status=SecItemCopyMatching((__bridge CFDictionaryRef)lookup,&raw);
    NSArray *records=raw ? CFBridgingRelease(raw) : nil;
    if (status==errSecSuccess && (![records isKindOfClass:NSArray.class] || records.count!=1)) {
      napi_throw_error(env,NULL,"Legacy synthetic item ownership is ambiguous"); return NULL;
    }
    NSDictionary *record=status==errSecSuccess ? records[0] : nil;
    NSDate *created=record[(__bridge id)kSecAttrCreationDate], *modified=record[(__bridge id)kSecAttrModificationDate];
    double createdMs=[created isKindOfClass:NSDate.class] ? round(created.timeIntervalSince1970*1000) : 0;
    double modifiedMs=[modified isKindOfClass:NSDate.class] ? round(modified.timeIntervalSince1970*1000) : 0;
    if (remove && status==errSecSuccess) {
      NSData *reference=record[(__bridge id)kSecValuePersistentRef];
      if (createdMs!=expectedCreated || modifiedMs!=expectedModified || ![reference isKindOfClass:NSData.class] || !uiDisabled()) {
        napi_throw_error(env,NULL,"Legacy synthetic item creation metadata changed"); return NULL;
      }
      NSMutableDictionary *selected=query();
      [selected removeObjectForKey:(__bridge id)kSecAttrService];
      [selected removeObjectForKey:(__bridge id)kSecAttrAccount];
      selected[(__bridge id)kSecMatchItemList]=@[reference];
      status=SecItemDelete((__bridge CFDictionaryRef)selected);
    }
    napi_value result;
    if (napi_create_object(env,&result)!=napi_ok || !number(env,result,"osStatus",status) || !number(env,result,"createdAtMs",createdMs) || !number(env,result,"modifiedAtMs",modifiedMs) || !boolean(env,result,"authenticationUIFail",YES) || !boolean(env,result,"interactionNotAllowed",YES) || !boolean(env,result,"absent",status==errSecItemNotFound)) {
      napi_throw_error(env,NULL,"Legacy synthetic metadata receipt failed"); return NULL;
    }
    return result;
  }
}
static napi_value inspect(napi_env env,napi_callback_info info) { return inspectOrRemove(env,info,NO); }
static napi_value removeMatching(napi_env env,napi_callback_info info) { return inspectOrRemove(env,info,YES); }
NAPI_MODULE_INIT() {
  napi_value readFunction,removeFunction;
  if (napi_create_function(env,"inspect",NAPI_AUTO_LENGTH,inspect,NULL,&readFunction)!=napi_ok || napi_create_function(env,"removeMatching",NAPI_AUTO_LENGTH,removeMatching,NULL,&removeFunction)!=napi_ok || napi_set_named_property(env,exports,"inspect",readFunction)!=napi_ok || napi_set_named_property(env,exports,"removeMatching",removeFunction)!=napi_ok) {
    napi_throw_error(env,NULL,"Legacy synthetic cleanup owner could not initialize"); return NULL;
  }
  return exports;
}
