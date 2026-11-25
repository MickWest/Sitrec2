#import "RuntimeAccess.h"
id SMReadProperty(NSObject *object, NSString *key, NSError **error) {
    @try { return [object valueForKey:key]; }
    @catch(NSException *exception) {
        if(error)*error=[NSError errorWithDomain:@"SitMapExperiment" code:1 userInfo:@{NSLocalizedDescriptionKey:exception.reason ?: exception.name}];
        return nil;
    }
}
BOOL SMWriteProperty(NSObject *object, NSString *key, id value, NSError **error) {
    @try { [object setValue:value forKey:key]; return YES; }
    @catch(NSException *exception) {
        if(error)*error=[NSError errorWithDomain:@"SitMapExperiment" code:2 userInfo:@{NSLocalizedDescriptionKey:exception.reason ?: exception.name}];
        return NO;
    }
}
