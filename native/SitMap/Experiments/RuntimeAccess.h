#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
FOUNDATION_EXPORT id _Nullable SMReadProperty(NSObject *object, NSString *key, NSError **error);
FOUNDATION_EXPORT BOOL SMWriteProperty(NSObject *object, NSString *key, id _Nullable value, NSError **error);
NS_ASSUME_NONNULL_END
