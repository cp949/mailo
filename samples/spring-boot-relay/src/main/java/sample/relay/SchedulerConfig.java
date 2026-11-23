package sample.relay;

import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.SchedulingConfigurer;
import org.springframework.scheduling.config.ScheduledTaskRegistrar;
import sample.relay.events.EventFeedPoller;
import sample.relay.relay.RelayWorker;

/** relay와 이벤트 피드 폴링을 설정한 간격으로 돌린다(앞 실행이 끝난 뒤부터 간격을 잰다). */
@Configuration
class SchedulerConfig implements SchedulingConfigurer {

    private final RelayWorker relay;
    private final EventFeedPoller events;
    private final RelayProperties props;

    SchedulerConfig(RelayWorker relay, EventFeedPoller events, RelayProperties props) {
        this.relay = relay;
        this.events = events;
        this.props = props;
    }

    @Override
    public void configureTasks(ScheduledTaskRegistrar registrar) {
        registrar.addFixedDelayTask(relay::tick, props.retry().pollInterval());
        registrar.addFixedDelayTask(events::poll, props.events().pollInterval());
    }
}
