// Expected: chroot fails without capabilities; exit 3 means it worked.
#include <unistd.h>
int main() { return chroot("/") == 0 ? 3 : 0; }
