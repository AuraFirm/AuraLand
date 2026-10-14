// Expected: MLE by the cgroup limit (off-heap memory is outside the heap limit) or RTE (heap exhausted).
import java.nio.ByteBuffer;
import java.util.ArrayList;
public class Main {
    public static void main(String[] args) {
        ArrayList<ByteBuffer> keep = new ArrayList<>();
        for (;;) { ByteBuffer b = ByteBuffer.allocateDirect(1 << 20); for (int i = 0; i < b.capacity(); i += 4096) b.put(i, (byte) 1); keep.add(b); }
    }
}
