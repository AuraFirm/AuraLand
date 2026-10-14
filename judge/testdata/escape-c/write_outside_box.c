// Expected: writes outside the box fail; exit 3 if a file could be created in /etc or /usr.
#include <fcntl.h>
#include <unistd.h>
int main(void) { return (open("/etc/aura_escape", O_WRONLY | O_CREAT, 0600) >= 0 || open("/usr/aura_escape", O_WRONLY | O_CREAT, 0600) >= 0) ? 3 : 0; }
