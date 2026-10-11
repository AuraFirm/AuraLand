// Expected: contained by the process limit (the box allows one process). Verdict RTE (fork fails and the program aborts) or TLE.
#include <unistd.h>
int main() { for (;;) fork(); }
