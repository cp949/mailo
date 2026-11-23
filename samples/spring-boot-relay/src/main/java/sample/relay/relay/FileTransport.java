package sample.relay.relay;

import java.io.IOException;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import sample.relay.mailo.FileChannelWriter;

/**
 * 파일 채널로 전달한다. 파일을 썼다는 것은 Mailo가 등록했다는 뜻이 아니다. 등록과 거부는 Mailo가 다음 폴링에서 정하고
 * 사용처는 이벤트 피드(INTAKE_REJECTED)나 Key 조회로 확인한다.
 */
@Component
@ConditionalOnProperty(prefix = "relay", name = "transport", havingValue = "FILE")
public class FileTransport implements RequestTransport {

    private final FileChannelWriter writer;

    public FileTransport(FileChannelWriter writer) {
        this.writer = writer;
    }

    @Override
    public Delivery send(UUID id, String requestJson) {
        try {
            writer.write(id, requestJson);
            return new Delivery(Delivery.Kind.DONE, null, null, null);
        } catch (IOException e) {
            return Delivery.retry(null, "FILE_IO_ERROR");
        }
    }
}
