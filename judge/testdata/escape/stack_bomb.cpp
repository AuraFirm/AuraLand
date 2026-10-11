// Expected: RTE (stack limit) or MLE.
static int deep(int n) { volatile char pad[4096]; pad[0] = (char)n; return pad[0] + deep(n + 1); }
int main() { return deep(0); }
