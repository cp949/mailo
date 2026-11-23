package sample.relay.mailo;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;
import sample.relay.RelayProperties;

/**
 * 파일 채널 쓰기(docs/operations/caller-onboarding.md 5절). 임시 이름에 쓰고 fsync, 0660, 같은 폴더 rename 순서다.
 * 파일 이름은 outbox 행 ID라서 INTAKE_REJECTED 이벤트의 {@code fileName}으로 행을 찾을 수 있다.
 */
@Component
public class FileChannelWriter {

    private final ObjectMapper mapper;
    private final Path inbox;
    private final ObjectProvider<RequestSigner> signer;

    public FileChannelWriter(RelayProperties props, ObjectMapper mapper, ObjectProvider<RequestSigner> signer) {
        this.mapper = mapper;
        this.signer = signer;
        this.inbox = props.fileInboxDir();
    }

    /** outbox의 REST 본문에 version·idempotencyKey를 더해 파일로 쓴다. 서명을 켰으면 JWS로 감싼다. */
    public void write(UUID id, String restRequestJson) throws IOException {
        if (inbox == null) {
            throw new IllegalStateException("relay.file-inbox-dir이 필요하다");
        }
        ObjectNode file = (ObjectNode) mapper.readTree(restRequestJson);
        file.put("version", 1);
        file.put("idempotencyKey", id.toString());
        String json = mapper.writeValueAsString(file);
        RequestSigner s = signer.getIfAvailable();
        String content = s == null ? json : s.sign(json); // 재시도마다 새 iat로 다시 서명한다.

        String finalName = id + ".json";
        Path tmp = inbox.resolve("." + finalName + ".tmp"); // 점으로 시작: Mailo가 무시한다
        Files.deleteIfExists(tmp);
        try (FileChannel ch = FileChannel.open(tmp, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            ByteBuffer buf = ByteBuffer.wrap(content.getBytes(StandardCharsets.UTF_8));
            while (buf.hasRemaining()) {
                ch.write(buf);
            }
            ch.force(true); // fsync
        }
        // Files.createFile류는 0600으로 만든다. Mailo가 읽으려면 rename 전에 0660이어야 한다.
        Files.setPosixFilePermissions(tmp, PosixFilePermissions.fromString("rw-rw----"));
        Files.move(tmp, inbox.resolve(finalName), StandardCopyOption.ATOMIC_MOVE);
    }
}
