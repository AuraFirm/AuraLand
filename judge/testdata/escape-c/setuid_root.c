// Expected: becoming root fails; exit 3 if setuid(0) succeeded.
#include <unistd.h>
int main(void) { return setuid(0) == 0 && getuid() == 0 && geteuid() == 0 ? 3 : 0; }
