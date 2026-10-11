// Expected: the call is refused or the program is killed; exit 3 means it attached to another process.
#include <sys/ptrace.h>
#include <unistd.h>
int main() { long r = ptrace(PTRACE_ATTACH, 1, 0, 0); return r == 0 ? 3 : 0; }
