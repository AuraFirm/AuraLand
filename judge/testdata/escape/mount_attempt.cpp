// Expected: mount fails (no capability); exit code 3 means a mount succeeded.
#include <sys/mount.h>
int main() { return mount("none", "/tmp", "tmpfs", 0, "") == 0 ? 3 : 0; }
