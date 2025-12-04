# Liquibook

오픈 소스 주문 매칭 엔진

Liquibook은 주문 매칭 엔진을 구성하는 저수준 컴포넌트를 제공합니다.

주문 매칭은 증권(또는 기타 대체 가능한 자산)에 대한 매수 및 매도 주문을 접수하고, 서로 알지 못하는 당사자 간의 거래를 성사시키기 위해 이를 매칭하는 과정입니다.

주문 매칭 엔진은 모든 금융 거래소의 핵심이며, 비금융 자산 거래, 트레이딩 알고리즘 테스트 베드 등 다양한 상황에서 사용될 수 있습니다.

일반적인 Liquibook 기반 애플리케이션은 다음과 같은 모습일 수 있습니다:
![Market Application](doc/Images/MarketApplication.png)

주문 매칭 프로세스 자체 외에도, Liquibook은 개별 가격 수준에서 오픈된 주문 수와 해당 주문이 나타내는 총 수량을 기록하는 "뎁스 북(depth book)"을 유지하도록 구성할 수 있습니다.

#### 뎁스 북(Depth Book) 예시
* 종목 XYZ:
  * 매수 측 (Buy Side):
    * 주당 $53.20: 주문 1203건; 150,398주
    * 주당 $53.19: 주문 87건; 63,28주
    * 주당 $52.00: 주문 3건; 2,150주
  * 매도 측 (Sell Side):
    * 주당 $54.00: 주문 507건; 120,700주
    * 등등...

## Liquibook이 지원하는 주문 속성

Liquibook은 다음 주문 속성을 인식합니다.

* Side (방향): 매수(Buy) 또는 매도(Sell)
* Quantity (수량)
* Symbol (종목): 거래할 자산을 나타냄
  * Liquibook은 심볼에 제한을 두지 않습니다. 단순 문자열로 처리됩니다.
* Desired price (희망 가격) 또는 "Market" (시장가): 시장에 의해 정의된 현재 가격 수용
  * 지정된 가격 또는 더 나은 가격(매도 주문의 경우 더 높은 가격, 매수 주문의 경우 더 낮은 가격)으로 거래가 생성됩니다.
* Stop loss price (손절매 가격): 시장 가격이 지정된 값에 도달할 때까지 주문을 보류
  * 흔히 스탑 가격(stop price)이라고 합니다.
* All or None (AON) 플래그: 전체 주문이 체결되거나 거래가 전혀 발생하지 않아야 함을 지정
* Immediate or Cancel (IOC) 플래그: 시장의 기존 주문에 대해 가능한 모든 거래가 이루어진 후, 주문의 나머지 부분은 취소되어야 함을 지정
  * 참고: All or None과 Immediate or Cancel을 결합하면 흔히 Fill or Kill이라고 하는 주문이 생성됩니다.

유일한 필수 속성은 방향(side), 수량(quantity), 가격(price)입니다. 다른 속성에는 기본값이 제공됩니다.

애플리케이션은 필요에 따라 주문 객체에 추가 속성을 정의할 수 있습니다. 이러한 속성은 Liquibook의 동작에 영향을 미치지 않습니다.

## 주문에 대한 작업 (Operations on Orders)

주문 제출 외에도 트레이더는 기존 주문을 취소하거나 수정(Modify)하는 요청을 제출할 수 있습니다. (수정은 취소/교체(cancel/replace)라고도 함)
요청은 주문에 대해 이전에 실행된 거래에 따라 성공하거나 실패할 수 있습니다.

## 애플리케이션으로 반환되는 알림 (Notifications)

Liquibook은 중요한 이벤트가 발생할 때 애플리케이션에 알림을 보내어, 애플리케이션이 Liquibook에 의해 식별된 거래를 실제로 실행하고 트레이더가 사용할 시장 데이터를 게시할 수 있도록 합니다.

생성되는 알림은 다음과 같습니다:

* 주문을 제출한 트레이더를 위한 알림:
  * 주문 접수됨 (Order accepted)
  * 주문 거부됨 (Order rejected)
  * 주문 체결됨 (전체 또는 부분) (Order filled)
  * 주문 교체됨 (Order replaced)
  * 교체 요청 거부됨 (Replace request rejected)
  * 주문 취소됨 (Order canceled)
  * 취소 요청 거부됨 (Cancel request rejected)
* 시장 데이터(Market Data)로 게시될 알림:
  * 거래 (Trade)
    * 참고: 이는 애플리케이션이 거래를 성사시키기 위해 필요한 작업을 수행하도록 트리거해야 합니다.
  * 증권 변경 (Security changed)
    * 증권에 영향을 미치는 모든 이벤트에 의해 트리거됨
      * 거부된 요청은 포함하지 않음
  * 뎁스 북 변경 알림 (활성화된 경우)
    * 뎁스 북 변경됨 (Depth book changed)
    * 최우선 매수/매도 호가(BBO) 변경됨 (Best Bid or Best Offer changed)


## 성능 (Performance)
* Liquibook은 최신 고성능 기법을 사용하여 C++로 작성되었습니다. 이 저장소에는 Liquibook 성능을 측정하는 데 사용할 수 있는 테스트 프로그램 소스가 포함되어 있습니다.
  * 이 프로그램으로 벤치마크 테스트를 수행한 결과 초당 __200만__ ~ __250만__ 건의 삽입(insert) 속도를 지속적으로 보여줍니다.

항상 그렇듯이, 이러한 유형의 성능 테스트 결과는 테스트를 실행하는 하드웨어 및 운영 체제에 따라 달라질 수 있으므로, 이 수치는 애플리케이션이 Liquibook에서 기대할 수 있는 성능의 대략적인 추정치로만 사용하십시오.

## 설계와의 호환성 (Works with Your Design)
* 애플리케이션이 주문에 대해 스마트 포인터 또는 일반 포인터를 사용할 수 있도록 허용합니다.
* 기존 주문 모델과 호환됨
  * 기존 Order 객체에 추가하거나 래핑할 수 있는 사소한 인터페이스가 필요합니다.
* 증권, 계정, 거래소, 주문, 체결에 대한 기존 식별자와 호환됨

## 예제 (Example)
이 저장소에는 두 개의 완전한 예제 프로그램이 포함되어 있습니다. 이 프로그램들은 Liquibook이 귀하의 요구 사항을 충족하는지 평가하는 데 사용할 수 있습니다. 또한 Liquibook이 배포되는 자유로운 라이선스 덕분에 애플리케이션의 모델로 사용하거나 애플리케이션에 직접 통합할 수도 있습니다.

예제는 다음과 같습니다:
* 뎁스 피드 게시자 및 구독자 (Depth feed publisher and subscriber)
  * 주문을 생성하여 Liquibook에 제출하고 결과 시장 데이터를 게시합니다.
  * [QuickFAST](https://github.com/objectcomputing/quickfast)를 사용하여 시장 데이터를 게시합니다.

* 수동 주문 입력 (Manual Order Entry)
  * 콘솔에서 입력하거나 스크립트(텍스트 파일)에서 읽은 주문 및 기타 요청을 허용합니다.
  * 이를 Liquibook에 제출합니다.
  * Liquibook에서 수신한 알림을 콘솔이나 로그 파일에 표시합니다.
  * [자세한 지침은 README_ORDER_ENTRY.md 파일에 있습니다.](README_ORDER_ENTRY.md)

# Liquibook 빌드하기
좋은 소식은 Liquibook을 빌드할 필요가 없다는 것입니다. Liquibook의 핵심은 헤더 전용(header-only) 라이브러리이므로, Liquibook/src를 인클루드 경로에 추가한 다음 소스에 `#include <book/order_book.h>`를 추가하기만 하면 애플리케이션에서 Liquibook을 사용할 수 있습니다.

그러나 이 저장소에는 Liquibook용 테스트 및 예제 프로그램이 포함되어 있습니다. 이 프로그램들을 실행하려면 컴파일하고 빌드해야 합니다. 이 섹션의 나머지 부분에서는 이를 수행하는 방법을 설명합니다.

## 의존성 (Dependencies)
Liquibook에는 런타임 의존성이 없습니다. C++ 프로그램을 실행할 수 있는 모든 환경에서 실행됩니다.

소스에서 Liquibook 테스트 및 예제 프로그램을 빌드하려면 메이크파일(linux 등) 또는 Windows Visual Studio용 프로젝트 및 솔루션 파일을 생성해야 합니다.

Liquibook은 MPC를 사용하여 공통 빌드 정의에서 이러한 플랫폼 종속 파일을 생성합니다:
* [MPC](https://github.com/objectcomputing/MPC): 크로스 플랫폼 빌드용.

  MPC 자체는 펄(perl)로 작성되었으므로 환경에 작동하는 Perl 컴파일러가 필요합니다. 대부분의 리눅스 시스템에는 이미 있습니다. Windows에서 Perl 컴파일러가 필요한 경우 OCI는 [Active State Perl V5.x 이상](http://www.activestate.com/)을 권장합니다.

Liquibook에 대한 단위 테스트를 빌드하려면 부스트 테스트 라이브러리도 필요합니다:
* [BOOST](http://www.boost.org/) (선택 사항): 단위 테스트용.

예제 프로그램 중 하나(시장 데이터 게시 및 구독)는 QuickFAST를 사용하여 시장 데이터 메시지를 인코딩 및 디코딩합니다. 이 예제를 실행하려면 QuickFAST가 필요합니다:
* [QuickFAST](https://github.com/objectcomputing/quickfast) (선택 사항): 예제 뎁스 피드 게시자/구독자 빌드용.

  QuickFAST에는 자체 의존성이 있으며 해당 웹 페이지에 설명되어 있습니다.

## 서브모듈 참고 (Submodule Note)
이전 버전에서는 Assertive 테스트 프레임워크가 사용되었지만 더 이상 필요하지 않습니다.
이전 버전을 지원하기 위해 이 서브모듈을 가져온 경우 liquibook/test/unit/assertiv 디렉터리를 삭제할 수 있습니다.

## 테스트 및 예제 프로그램 빌드 준비

### Boost Test
Liquibook 단위 테스트를 실행하려면(적극 권장!) Liquibook을 빌드하기 전에 boost test를 설치 및/또는 빌드해야 합니다. Boost test는 단순한 헤더 전용 모드가 아닌 다중 파일 테스트 모드에서 사용되므로 컴파일된 boost test 라이브러리를 사용할 수 있어야 합니다.

환경에서 라이브러리를 빌드/설치하려면 [boost 웹사이트](http://www.boost.org/)의 지침을 따르십시오.
완료되면 $BOOST_ROOT 환경 변수를 내보내야(export) 합니다.

많은 boost 빌드 옵션 때문에 인클루드 파일과 라이브러리 파일이 예상 위치에 있는지 확인하십시오.
MPC는 다음을 찾을 것으로 예상합니다:
* 인클루드 파일: $BOOST_ROOT/include/boost
* 라이브러리 파일: $BOOST_ROOT/lib


boost를 설치하지 않으려면 liquibook.features 파일을 편집하여 해당 줄을 `boost=0`으로 변경할 수 있습니다. 이렇게 하면 단위 테스트 빌드가 비활성화됩니다.

### QuickFAST
게시 및 구독 예제 프로그램은 QuickFAST를 사용합니다. 이 예제 프로그램을 실행하려면 [QuickFAST 웹사이트](https://github.com/objectcomputing/quickfast)를 참조하여 라이브러리를 다운로드하고 빌드하십시오.

$QUICKFAST_ROOT 환경 변수를 QuickFAST를 설치하고 빌드한 위치를 가리키도록 설정하십시오.

MPC를 실행하기 전에 liquibook.features 파일을 편집하여 QuickFAST=1 값을 설정해야 합니다.

이 예제 프로그램을 실행할 계획이 없다면 QUICKFAST_ROOT 환경 변수를 liquibook/noQuickFAST로 설정하십시오.

## Linux에서 Liquibook 빌드하기

env.sh 스크립트는 대부분의 Linux/Unix 시스템에 존재하는 readlink 프로그램을 사용합니다.
readlink가 없는 경우 env.sh를 실행하기 전에 $LIQUIBOOK_ROOT 환경 변수를 liquibook이 포함된 디렉터리로 설정하십시오.

쉘을 열고 다음을 입력하십시오:

<pre>
$ cd liquibook
$ . ./env.sh
$ $MPC_ROOT/mwc.pl -type make liquibook.mwc
$ make depend
$ make all
</pre>

### 빌드 결과물 (Output from build)
* Liquibook 테스트 및 예제 라이브러리는 $LIQUIBOOK_ROOT/lib에 있습니다.
* Liquibook 예제 프로그램은 $LIQUIBOOK_ROOT/bin에 있습니다.
* Liquibook 테스트 프로그램은 $LIQUIBOOK_ROOT/bin/test에 있습니다.

## Visual Studio로 Liquibook 예제 및 테스트 프로그램 빌드하기

다음 명령을 사용하여 빌드 환경을 설정하고 Visual Studio 프로젝트 및 솔루션 파일을 생성하십시오.
MinGW 또는 기타 Windows상의 Linux 기술을 사용하는 경우 Linux 지침을 따르십시오. 그러나 OCI는 일반적으로 이를 테스트하지 않습니다.

<pre>
> cd liquibook
> copy winenv.bat w.bat # 선택 사항: 원본을 유지하려는 경우
                        # 참고: 한 글자 배치 파일 이름은 .gitignore에서 무시되므로
                        # 사용자 정의된 파일이 git 저장소에 체크인되지 않습니다(좋은 점).
> edit w.bat            # edit는 원하는 텍스트 편집기입니다.
                        # 파일 자체의 지침을 따르십시오.
> w.bat                 # 환경 변수를 설정하고 확인합니다.
> mpc.bat               # Visual Studio 솔루션 및 프로젝트 파일을 생성합니다.
</pre>

그 다음:
* 명령줄에서 liquibook.sln을 입력하여 Visual Studio를 시작하거나
* Windows 메뉴에서 Visual Studio를 시작하고 메뉴 파일|열기|프로젝트 또는 솔루션을 사용하여 liquibook.sln을 로드합니다.

## 모든 플랫폼 (For any platform)

Liquibook은 최신 C++ 컴파일러(최소 C++11 지원)가 있는 모든 플랫폼에서 작동해야 합니다.

빌드 파일을 생성하는 데 사용되는 MPC 프로그램과 테스트 및 일부 예제에서 사용되는 Boost 라이브러리는 다양한 플랫폼을 지원합니다.

환경에서 MPC를 사용하는 방법에 대한 자세한 내용은 [MPC 문서](https://github.com/objectcomputing/MPC)를 참조하십시오.

환경에서 Boost를 사용하는 방법에 대한 자세한 내용은 [Boost 웹사이트](http://www.boost.org/)를 참조하십시오.
