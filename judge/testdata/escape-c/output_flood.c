// Expected: OLE (file size limit / output cap).
#include <stdio.h>
int main(void) { for (;;) fputs("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n", stdout); }
