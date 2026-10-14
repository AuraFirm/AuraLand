// Expected: unshare of new namespaces fails or is already confined; exit 3 means it created one.
#define _GNU_SOURCE
#include <sched.h>
int main(void) { return unshare(CLONE_NEWUSER | CLONE_NEWNS) == 0 ? 3 : 0; }
