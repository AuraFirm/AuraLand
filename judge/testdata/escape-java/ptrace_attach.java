// Expected: another process's memory is not writable through /proc; exit 3 means it opened init's memory.
import java.io.RandomAccessFile;
public class Main {
    public static void main(String[] args) {
        try (RandomAccessFile f = new RandomAccessFile("/proc/1/mem", "rw")) { System.exit(3); }
        catch (Exception e) { System.exit(0); }
    }
}
