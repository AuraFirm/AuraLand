// Expected: cannot signal other processes; exit 3 if signalling init succeeded.
#include <csignal>
#include <unistd.h>
int main() { return kill(1, 0) == 0 ? 3 : 0; }
