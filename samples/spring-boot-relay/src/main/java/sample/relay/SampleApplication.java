package sample.relay;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;

/** 사용처 샘플: 비즈니스 트랜잭션과 outbox를 함께 쓰고, relay가 Mailo로 전달한다(RQ-021). */
@SpringBootApplication
@EnableScheduling
@ConfigurationPropertiesScan
public class SampleApplication {

    public static void main(String[] args) {
        SpringApplication.run(SampleApplication.class, args);
    }
}
