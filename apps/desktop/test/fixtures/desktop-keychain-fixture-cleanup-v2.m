#include <node_api.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <LocalAuthentication/LocalAuthentication.h>

#ifndef OMNYO_FIXTURE_STORAGE_NAME
#error OMNYO_FIXTURE_STORAGE_NAME is required
#endif

static napi_value cleanup(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    NSString *name=@OMNYO_FIXTURE_STORAGE_NAME;
    if (![name hasPrefix:@"Omnyo Closed Transfer "] || ![name hasSuffix:@" Legacy"] || name.length!=@"Omnyo Closed Transfer ".length+36+@" Legacy".length) {
      napi_throw_error(env,NULL,"The exact synthetic creator namespace is required");
      return NULL;
    }
    OSStatus fenced=SecKeychainSetUserInteractionAllowed(false);
    Boolean interactive=true;
    if (fenced || SecKeychainGetUserInteractionAllowed(&interactive) || interactive) {
      napi_throw_error(env,NULL,"Synthetic creator interaction fence failed");
      return NULL;
    }
    LAContext *context=[LAContext new];
    context.interactionNotAllowed=YES;
    NSDictionary *base=@{
      (__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService:[name stringByAppendingString:@" Safe Storage"],
      (__bridge id)kSecAttrAccount:[name stringByAppendingString:@" Key"],
      (__bridge id)kSecUseAuthenticationUI:(__bridge id)kSecUseAuthenticationUIFail,
      (__bridge id)kSecUseAuthenticationContext:context
    };
    NSMutableDictionary *query=[base mutableCopy];
    query[(__bridge id)kSecMatchLimit]=(__bridge id)kSecMatchLimitOne;
    query[(__bridge id)kSecReturnAttributes]=@YES;
    CFTypeRef raw=NULL;
    OSStatus before=SecItemCopyMatching((__bridge CFDictionaryRef)query,&raw);
    BOOL exact=before==errSecItemNotFound;
    if (before==errSecSuccess && raw && CFGetTypeID(raw)==CFDictionaryGetTypeID()) {
      NSDictionary *attributes=(__bridge NSDictionary *)raw;
      exact=[attributes[(__bridge id)kSecAttrService] isEqual:base[(__bridge id)kSecAttrService]] &&
        [attributes[(__bridge id)kSecAttrAccount] isEqual:base[(__bridge id)kSecAttrAccount]];
    }
    if (raw) CFRelease(raw);
    OSStatus deleted=errSecItemNotFound;
    if (before==errSecSuccess && exact) {
      NSMutableDictionary *reference=[base mutableCopy];
      reference[(__bridge id)kSecMatchLimit]=(__bridge id)kSecMatchLimitOne;
      reference[(__bridge id)kSecReturnRef]=@YES;
      CFTypeRef item=NULL;
      deleted=SecItemCopyMatching((__bridge CFDictionaryRef)reference,&item);
      if (deleted==errSecSuccess && item && CFGetTypeID(item)==SecKeychainItemGetTypeID())
        deleted=SecKeychainItemDelete((SecKeychainItemRef)item);
      else if (deleted==errSecSuccess) deleted=errSecParam;
      if (item) CFRelease(item);
    }
    CFTypeRef afterRaw=NULL;
    OSStatus after=SecItemCopyMatching((__bridge CFDictionaryRef)query,&afterRaw);
    if (afterRaw) CFRelease(afterRaw);
    Boolean finalInteractive=true;
    BOOL disabled=SecKeychainGetUserInteractionAllowed(&finalInteractive)==errSecSuccess && !finalInteractive && context.interactionNotAllowed;
    napi_value result,value;
    if (napi_create_object(env,&result)!=napi_ok) return NULL;
    const char *keys[]={"beforeOsStatus","deleteOsStatus","afterOsStatus"};
    OSStatus statuses[]={before,deleted,after};
    for (unsigned int index=0;index<3;index++)
      if (napi_create_int32(env,statuses[index],&value)!=napi_ok || napi_set_named_property(env,result,keys[index],value)!=napi_ok) return NULL;
    if (napi_get_boolean(env,exact,&value)!=napi_ok || napi_set_named_property(env,result,"exactAttributes",value)!=napi_ok ||
      napi_get_boolean(env,disabled,&value)!=napi_ok || napi_set_named_property(env,result,"interactionNotAllowed",value)!=napi_ok) return NULL;
    return result;
  }
}

NAPI_MODULE_INIT() {
  napi_value function;
  if (napi_create_function(env,"cleanupSyntheticOwnedItemV2",NAPI_AUTO_LENGTH,cleanup,NULL,&function)!=napi_ok ||
    napi_set_named_property(env,exports,"cleanupSyntheticOwnedItemV2",function)!=napi_ok) return NULL;
  return exports;
}
