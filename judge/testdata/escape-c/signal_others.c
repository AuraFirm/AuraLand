// Expected: cannot signal other processes; exit 3 if signalling init succeeded.
#include <signal.h>
#include <unistd.h>
int main(void) { return kill(1, 0) == 0 ? 3 : 0; }
