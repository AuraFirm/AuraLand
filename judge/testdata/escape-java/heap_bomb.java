// Expected: RTE (the heap is bounded; OutOfMemoryError ends the program) or MLE.
import java.util.ArrayList;
public class Main {
    public static void main(String[] args) {
        ArrayList<long[]> keep = new ArrayList<>();
        for (;;) { long[] a = new long[1 << 17]; java.util.Arrays.fill(a, 1L); keep.add(a); }
    }
}
