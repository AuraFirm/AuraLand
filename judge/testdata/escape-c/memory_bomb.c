// Expected: MLE by the cgroup limit.
#include <stdlib.h>
#include <string.h>
int main(void) { for (;;) { char *p = (char *)malloc(1 << 20); if (p) memset(p, 1, 1 << 20); } }
