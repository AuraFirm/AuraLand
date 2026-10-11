// Expected: MLE by the cgroup limit.
#include <cstdlib>
#include <cstring>
int main() { for (;;) { char *p = (char *)malloc(1 << 20); if (p) memset(p, 1, 1 << 20); } }
