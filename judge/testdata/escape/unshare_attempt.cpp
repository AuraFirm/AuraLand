// Expected: unshare of new namespaces fails or is already confined; exit 3 means it created one.
#include <sched.h>
int main() { return unshare(CLONE_NEWUSER | CLONE_NEWNS) == 0 ? 3 : 0; }
