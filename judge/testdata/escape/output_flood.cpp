// Expected: OLE (file size limit / output cap).
#include <cstdio>
int main() { for (;;) fputs("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n", stdout); }
