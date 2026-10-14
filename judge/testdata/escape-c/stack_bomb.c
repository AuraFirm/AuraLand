// Expected: RTE (stack limit) or MLE.
// Not a tail call and not inlined, so the compiler cannot turn the recursion into a loop.
static int deep(int n) __attribute__((noinline));
static int deep(int n) {
    volatile char pad[4096];
    pad[0] = (char)n;
    int below = deep(n + 1);
    pad[1] = (char)below;
    return pad[0] + pad[1];
}
int main(void) { return deep(0); }
